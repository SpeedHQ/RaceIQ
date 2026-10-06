fn main() {
    if let Err(error) = raceiq_recorder::pipeline_benchmark::stdio() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
