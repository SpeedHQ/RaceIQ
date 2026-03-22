use ini::Ini;
use std::env;
use std::net::{SocketAddr, UdpSocket};
use std::path::PathBuf;
use std::process;

const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() {
    if env::args().any(|a| a == "--version" || a == "-v") {
        println!("udp-forwarder {}", VERSION);
        return;
    }

    let config_path = env::args().nth(1).unwrap_or_else(|| {
        let exe_dir = env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("."));
        exe_dir
            .join("config.ini")
            .to_string_lossy()
            .into_owned()
    });

    let conf = Ini::load_from_file(&config_path).unwrap_or_else(|e| {
        eprintln!("Failed to load config '{}': {}", config_path, e);
        process::exit(1);
    });

    let general = conf.section(Some("general")).unwrap_or_else(|| {
        eprintln!("Missing [general] section in config");
        process::exit(1);
    });

    let listen_port: u16 = general
        .get("listen_port")
        .unwrap_or_else(|| {
            eprintln!("Missing 'listen_port' in [general]");
            process::exit(1);
        })
        .parse()
        .unwrap_or_else(|e| {
            eprintln!("Invalid listen_port: {}", e);
            process::exit(1);
        });

    let mut targets: Vec<SocketAddr> = Vec::new();

    for (key, _) in conf.iter() {
        let section_name: &str = match key {
            Some(name) if name.starts_with("forward") => name,
            _ => continue,
        };

        let section = conf.section(Some(section_name)).unwrap();

        let ip = section.get("ip").unwrap_or_else(|| {
            eprintln!("[{}] missing 'ip'", section_name);
            process::exit(1);
        });

        let port: u16 = section
            .get("port")
            .unwrap_or_else(|| {
                eprintln!("[{}] missing 'port'", section_name);
                process::exit(1);
            })
            .parse()
            .unwrap_or_else(|e| {
                eprintln!("[{}] invalid port: {}", section_name, e);
                process::exit(1);
            });

        let addr: SocketAddr = format!("{}:{}", ip, port).parse().unwrap_or_else(|e| {
            eprintln!("[{}] invalid address {}:{} — {}", section_name, ip, port, e);
            process::exit(1);
        });

        targets.push(addr);
    }

    if targets.is_empty() {
        eprintln!("No [forward.*] sections found in config");
        process::exit(1);
    }

    let bind_addr = format!("0.0.0.0:{}", listen_port);
    let socket = UdpSocket::bind(&bind_addr).unwrap_or_else(|e| {
        eprintln!("Failed to bind to {}: {}", bind_addr, e);
        process::exit(1);
    });

    println!("Listening on UDP port {}", listen_port);
    for target in &targets {
        println!("  Forwarding to {}", target);
    }

    let mut buf = [0u8; 65535];

    loop {
        let (len, _src) = match socket.recv_from(&mut buf) {
            Ok(result) => result,
            Err(e) => {
                eprintln!("recv error: {}", e);
                continue;
            }
        };

        let data = &buf[..len];

        for target in &targets {
            if let Err(e) = socket.send_to(data, target) {
                eprintln!("Failed to forward to {}: {}", target, e);
            }
        }
    }
}
