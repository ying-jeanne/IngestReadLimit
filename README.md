# IngestReadLimit
This repo contains k6 script for test ingest read limit

# Steps to run the script:
- Install xk6, used for building k6 with additional modules

```sh
go install go.k6.io/xk6/cmd/xk6@latest
```

- Build k6 with k6-client-prometheus-remote support using xk6

```sh
xk6 build --with github.com/grafana/xk6-client-prometheus-remote@latest
```

- Set environment variable
```sh
source variable.sh
```
- Run script
```sh
./k6 run test_script.js
```
