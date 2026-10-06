#[cfg(not(feature = "benchmark-memory"))]
compile_error!("run with --features benchmark-memory");

fn main() {
    use raceiq_recorder::memory_accounting::{Scope, current_live_bytes};
    let fixture_padding = vec![0u8; 64 * 1024 * 1024];
    std::hint::black_box(&fixture_padding);
    let before = current_live_bytes();
    assert!(before >= fixture_padding.len());

    let scope = Scope::begin();
    let mut buffer = Vec::<u8>::with_capacity(1024 * 1024);
    buffer.resize(1024 * 1024, 7);
    let larger = buffer.capacity() * 2;
    buffer.reserve_exact(larger - buffer.len());
    std::hint::black_box(&buffer);
    let (peak, retained) = scope.finish();
    std::hint::black_box(&buffer);
    assert_eq!(peak, 2 * 1024 * 1024);
    assert_eq!(retained, 2 * 1024 * 1024);
    drop(buffer);

    let scope = Scope::begin();
    let (empty_peak, _) = scope.finish();
    assert_eq!(empty_peak, 0);
    std::hint::black_box(&fixture_padding);
    assert!(fixture_padding.len() >= 64 * 1024 * 1024);
    println!("allocator scope smoke passed: peak={peak}, retained={retained}, outside={empty_peak}");
}
