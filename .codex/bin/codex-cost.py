#!/usr/bin/env python3
"""Read-only Codex rollout token audit. No credentials, quota writes or guessed prices.

Rates JSON maps exact model IDs to rows with input, cached_input, output (USD/M),
optionally cache_write; a row may have since/until ISO timestamps. Model values
may be lists of historical rows. Reasoning output is already included in output.
Protocol: openai/codex codex-rs/protocol/src/protocol.rs TokenUsageInfo.
"""
import argparse
import datetime as dt
from decimal import Decimal
import json
import math
import os
from pathlib import Path
import subprocess
import sys

FIELDS = ('input_tokens', 'cached_input_tokens', 'cache_write_input_tokens',
          'output_tokens', 'reasoning_output_tokens', 'total_tokens')


def validated_usage(value):
    if not isinstance(value, dict) or 'total_tokens' not in value:
        raise ValueError('token usage requires total_tokens')
    usage = {key: value.get(key, 0) for key in FIELDS}
    if any(isinstance(v, bool) or not isinstance(v, int) or v < 0 for v in usage.values()):
        raise ValueError('invalid token counter')
    if usage['total_tokens'] != usage['input_tokens'] + usage['output_tokens']:
        raise ValueError('total_tokens must equal input_tokens plus output_tokens')
    if usage['cached_input_tokens'] + usage['cache_write_input_tokens'] > usage['input_tokens']:
        raise ValueError('cached input and cache writes exceed input_tokens')
    if usage['reasoning_output_tokens'] > usage['output_tokens']:
        raise ValueError('reasoning_output_tokens exceeds output_tokens')
    return usage


def instant(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return None


def load_rates(path):
    if not path:
        return {}
    rates = json.loads(Path(path).read_text())
    if not isinstance(rates, dict):
        raise ValueError('rates must map exact model names to rate rows')
    for model, value in rates.items():
        for row in value if isinstance(value, list) else [value]:
            if not isinstance(row, dict):
                raise ValueError(f'invalid rate row for {model}')
            for field in ('input', 'cached_input', 'output'):
                if field not in row:
                    raise ValueError(f'{model}: missing {field} USD per million tokens')
            for field in ('input', 'cached_input', 'output', 'cache_write'):
                number = row.get(field, 0)
                if (isinstance(number, bool) or not isinstance(number, (int, float))
                        or number < 0 or number > sys.float_info.max or not math.isfinite(number)):
                    raise ValueError(f'{model}: invalid {field} rate')
            for field in ('since', 'until'):
                if field in row and instant(row[field]) is None:
                    raise ValueError(f'{model}: invalid {field} timestamp')
            if 'since' in row and 'until' in row and instant(row['since']) >= instant(row['until']):
                raise ValueError(f'{model}: empty historical rate interval')
    return rates


def price(model, timestamp, tokens, rates):
    value = rates.get(model, [])
    for row in value if isinstance(value, list) else [value]:
        when = instant(timestamp)
        if ('since' in row or 'until' in row) and when is None:
            continue
        if 'since' in row and when < instant(row['since']):
            continue
        if 'until' in row and when >= instant(row['until']):
            continue
        if tokens['cache_write_input_tokens'] and 'cache_write' not in row:
            return None
        # Cache hits and writes are subsets of input, reasoning a subset of output.
        uncached = max(0, tokens['input_tokens'] - tokens['cached_input_tokens'] - tokens['cache_write_input_tokens'])
        dollars = float((uncached * Decimal(str(row['input']))
                         + tokens['cached_input_tokens'] * Decimal(str(row['cached_input']))
                         + tokens['cache_write_input_tokens'] * Decimal(str(row.get('cache_write', 0)))
                         + tokens['output_tokens'] * Decimal(str(row['output']))) / 1_000_000)
        if not math.isfinite(dollars):
            raise ValueError('priced usage exceeds the finite USD reporting range')
        return dollars
    return None


def project(cwd, fold):
    if not fold or not cwd:
        return cwd or '(unknown cwd)'
    try:
        common = subprocess.check_output(['git', '-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
                                         stderr=subprocess.DEVNULL, timeout=3, text=True,
                                         env={k: v for k, v in os.environ.items() if not k.startswith('GIT_')}).strip()
        return str(Path(common).parent) if Path(common).name == '.git' else cwd
    except (OSError, subprocess.SubprocessError):
        return cwd


def audit(directory, rates=None, since=None, fold=True):
    directory = Path(directory)
    if not directory.is_dir():
        raise ValueError(f'sessions directory does not exist: {directory}')
    rates = rates or {}
    warnings, rows, events = [], {}, {}
    files = sorted(directory.rglob('*.jsonl'))
    ordinal = 0
    for path in files:
        sid, cwd, model, fork_start = str(path), '', '(unknown model)', None
        got_usage = False
        with path.open() as stream:
            for line_no, line in enumerate(stream, 1):
                try:
                    record = json.loads(line)
                    payload = record.get('payload') or {}
                    if not isinstance(payload, dict):
                        raise ValueError('invalid payload')
                    kind = record.get('type')
                    if kind == 'session_meta':
                        if 'id' in payload:
                            identity = payload['id']
                            if not isinstance(identity, str) or not identity.strip():
                                raise ValueError('session id must be a nonempty string')
                            sid = identity
                        cwd = payload.get('cwd', cwd)
                        if payload.get('forked_from_id'):
                            fork_start = instant(payload.get('timestamp'))
                            if fork_start is None:
                                warnings.append(f'{path}: fork boundary unknown; skipped')
                                break
                    elif kind == 'turn_context':
                        model, cwd = payload.get('model', model), payload.get('cwd', cwd)
                    elif kind == 'event_msg' and payload.get('type') == 'token_count' and payload.get('info'):
                        info = payload['info']
                        current = validated_usage(info['total_token_usage'])
                        if not isinstance(model, str) or not isinstance(cwd, str):
                            raise ValueError('invalid model or cwd')
                        when = instant(record.get('timestamp'))
                        ordinal += 1
                        events.setdefault(sid, []).append(dict(
                            current=current, timestamp=record.get('timestamp'), when=when,
                            model=model, cwd=cwd, fork_start=fork_start,
                            last=info.get('last_token_usage'), ordinal=ordinal,
                            location=f'{path}:{line_no}'))
                        got_usage = True
                except (ValueError, KeyError, TypeError, AttributeError) as exc:
                    warnings.append(f'{path}:{line_no}: skipped invalid record ({exc})')
        if not got_usage:
            warnings.append(f'{path}: no persisted token counters')

    # Resumed/copied rollouts can split a session across files. Merge its events
    # before computing increments: filename order and file-local zero baselines
    # otherwise rebill the already-counted prefix. Preserve each event's model
    # context rather than applying a session's final model to its whole history.
    for sid, session_events in events.items():
        previous = {k: 0 for k in FIELDS}
        fork_baseline = False
        seen = set()
        session_events.sort(key=lambda event: (
            event['when'] or dt.datetime.max.replace(tzinfo=dt.timezone.utc), event['ordinal']))
        for event in session_events:
            current, when = event['current'], event['when']
            location = event['location']
            # A cumulative total may recur after a reset. Only duplicate
            # persisted events (timestamp + total/last usage) are deduplicated;
            # the current total alone is not an event identity.
            signature = (json.dumps(event['timestamp'], sort_keys=True), tuple(current[k] for k in FIELDS),
                         json.dumps(event['last'], sort_keys=True))
            if signature in seen:
                continue
            seen.add(signature)
            if when is None:
                warnings.append(f'{location}: missing timestamp; cross-file ordering is incomplete')
            if current['total_tokens'] < previous['total_tokens']:
                warnings.append(f'{location}: counter reset; new usage epoch starts here')
                delta = current.copy()
            else:
                delta = {k: max(0, current[k] - previous[k]) for k in FIELDS}
                if any(current[k] < previous[k] for k in FIELDS):
                    warnings.append(f'{location}: component counter decreased; attribution is incomplete')
            previous = current
            if not delta['total_tokens']:
                continue
            fork_start = event['fork_start']
            if fork_start and (when is None or when < fork_start):
                fork_baseline = True
                continue
            if fork_start and not fork_baseline:
                # A fork may carry cumulative parent usage without its copied
                # prefix. Only the first last-response increment is attributable.
                last = event['last']
                if not isinstance(last, dict):
                    warnings.append(f'{location}: fork baseline missing; usage skipped')
                    fork_baseline = True
                    continue
                try:
                    delta = validated_usage(last)
                except ValueError as exc:
                    warnings.append(f'{location}: invalid fork last-token counter ({exc}); usage skipped')
                    fork_baseline = True
                    continue
                warnings.append(f'{location}: fork prefix absent; first increment uses last-response usage only')
                fork_baseline = True
            if since and (when is None or when < since):
                continue
            key = (project(event['cwd'], fold), sid, event['model'])
            row = rows.setdefault(key, dict(project=key[0], session=sid, model=event['model'],
                **{k: 0 for k in FIELDS}, notional_usd=0.0, unpriced_tokens=0))
            for k in FIELDS:
                row[k] += delta[k]
            dollars = price(event['model'], event['timestamp'], delta, rates)
            if dollars is None:
                row['unpriced_tokens'] += delta['total_tokens']
            else:
                row['notional_usd'] += dollars
                if not math.isfinite(row['notional_usd']):
                    raise ValueError('priced subtotal exceeds the finite USD reporting range')
    return dict(sessions_dir=str(directory.resolve()), files_scanned=len(files),
                rows=list(rows.values()), warnings=warnings,
                coverage='Persisted rollout counters only; missing/deleted/non-JSONL history is not included. '
                         'Cumulative increments use the current turn model; missing usage events or model boundaries limit attribution. '
                         'Dollars use supplied rates and are not subscription quota or an invoice.')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sessions-dir', default=str(Path(os.environ.get('CODEX_HOME', Path.home() / '.codex')) / 'sessions'))
    parser.add_argument('--rates', help='JSON exact model rates in USD per million tokens; omitted models remain unpriced')
    parser.add_argument('--since', help='inclusive ISO date/timestamp')
    parser.add_argument('--sessions', action='store_true')
    parser.add_argument('--by-model', action='store_true')
    parser.add_argument('--no-fold', action='store_true')
    parser.add_argument('--top', type=int, default=0)
    parser.add_argument('--json', action='store_true')
    args = parser.parse_args(argv)
    try:
        since = instant(args.since) if args.since else None
        if args.since and since is None:
            raise ValueError('invalid --since date')
        if args.top < 0:
            raise ValueError('--top must be nonnegative')
        report = audit(args.sessions_dir, load_rates(args.rates), since, not args.no_fold)
    except (ValueError, OSError) as exc:
        parser.error(str(exc))
    grouped = {}
    for row in report['rows']:
        keys = ('project',) + (('session',) if args.sessions else ()) + (('model',) if args.by_model else ())
        key = tuple(row[k] for k in keys)
        dest = grouped.setdefault(key, {**{k: row[k] for k in keys}, **{k: 0 for k in FIELDS}, 'notional_usd': 0.0, 'unpriced_tokens': 0})
        for k in (*FIELDS, 'notional_usd', 'unpriced_tokens'):
            dest[k] += row[k]
        if not math.isfinite(dest['notional_usd']):
            parser.error('grouped priced subtotal exceeds the finite USD reporting range')
    report['unpriced_models'] = sorted({row['model'] for row in report['rows'] if row['unpriced_tokens']})
    report['rows'] = sorted(grouped.values(), key=lambda r: r['total_tokens'], reverse=True)
    report['top'] = args.top
    if args.top:
        report['rows'] = report['rows'][:args.top]
    if args.json:
        print(json.dumps(report, indent=2, allow_nan=False))
    else:
        print(f"Coverage: {report['sessions_dir']} ({report['files_scanned']} rollout files)")
        for row in report['rows']:
            label = ' / '.join(str(row[k]) for k in ('project', 'session', 'model') if k in row)
            print(f"{label}: {row['total_tokens']:,} tokens; ${row['notional_usd']:.4f} priced notional; {row['unpriced_tokens']:,} unpriced tokens")
        print(report['coverage'])
        if report['unpriced_models']:
            print('UNPRICED models: ' + ', '.join(report['unpriced_models']))
        for warning in report['warnings']:
            print('WARNING: ' + warning, file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
