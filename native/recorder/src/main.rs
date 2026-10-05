fn main() {
    if std::env::args().nth(1).as_deref() == Some("--benchmark-stdio") {
        if let Err(error) = raceiq_recorder::imports::benchmark_stdio() {
            eprintln!("recorder benchmark failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    if let Err(error) = raceiq_recorder::logger::init() {
        raceiq_recorder::logger::mark_degraded();
        eprintln!("recorder logger startup failed: {error}");
    }
    std::panic::set_hook(Box::new(|panic| {
        let detail = panic.to_string();
        raceiq_recorder::logger::log("fatal", &format!("panic: {detail}\n{}", std::backtrace::Backtrace::force_capture()));
        eprintln!("raceiq-recorder panic: {detail}");
    }));
    if let Err(error) = raceiq_recorder::engine::run() {
        raceiq_recorder::logger::log("fatal", &error);
        eprintln!("raceiq-recorder: {error}");
        std::process::exit(1);
    }
}
