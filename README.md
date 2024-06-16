# Vostok - simple content server for the Gemini protocol

## Creating certs

- `openssl genrsa -out vostok-key.pem 2048`
- `openssl req -new -sha256 -key vostok-key.pem -out vostok-csr.pem`
- `openssl x509 -req -in vostok-csr.pem -signkey vostok-key.pem -out vostok-cert.pem`
