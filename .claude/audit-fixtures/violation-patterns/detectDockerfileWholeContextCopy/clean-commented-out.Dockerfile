FROM alpine:3.20
# COPY . .   <- deliberately NOT used; see deploy-hygiene.md 9a
COPY entrypoint.sh ./
