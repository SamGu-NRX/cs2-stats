// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // `cs2-stats botmode ...` runs a Bot Mode command and exits without opening the window.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("botmode") {
        std::process::exit(cs2_stats_lib::botmode::cli::main(&args[1..]));
    }
    cs2_stats_lib::run()
}
