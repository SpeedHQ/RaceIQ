# UDP Forwarder

A lightweight UDP packet forwarder written in Rust. Listens on a single port and forwards all received packets to multiple destinations. Built for splitting Forza telemetry to multiple consumers.

## Usage

Place `config.ini` next to the binary, or pass a path as an argument:

```bash
./udp-forwarder                # uses config.ini next to the binary
./udp-forwarder my-config.ini  # custom config path
./udp-forwarder --version      # print version
```

## Configuration

Create a `config.ini` file (see `config.ini.example`):

```ini
[general]
listen_port = 5300

[forward.1]
ip = 127.0.0.1
port = 5301

[forward.2]
ip = 192.168.1.100
port = 5300
```

- `[general]` — `listen_port` is the UDP port to receive packets on
- `[forward.*]` — any section starting with `forward` defines a target. Each needs `ip` and `port`

## Building

```bash
cd udp-forwarder
cargo build --release
```

Binary outputs to `target/release/udp-forwarder`.

## Versioning

Version is tracked in `Cargo.toml` and embedded in the binary.

```bash
./bump-version.sh patch   # 0.1.0 → 0.1.1
./bump-version.sh minor   # 0.1.0 → 0.2.0
./bump-version.sh major   # 0.1.0 → 1.0.0
```

## Releasing

1. Bump the version: `./bump-version.sh patch`
2. Commit the change
3. Tag: `git tag udp-forwarder-v<version>`
4. Push: `git push && git push --tags`

The GitHub Actions workflow builds for Windows (x86_64), Linux (x86_64), and macOS (ARM), then creates a GitHub Release with zipped artifacts containing the binary and a default `config.ini`.
