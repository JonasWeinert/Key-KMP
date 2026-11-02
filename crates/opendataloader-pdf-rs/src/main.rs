use std::fs;
use std::path::PathBuf;

use anyhow::{bail, Context, Result};
use clap::{Parser, ValueEnum};
use opendataloader_pdf::{
    convert, convert_profiled,
    metrics::{MetricsReport, Profiler},
    to_markdown,
    visualize::render_layout_visualizations_profiled,
    ConvertOptions, TableReconciliationMode,
};

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Format {
    Json,
    #[value(alias = "md")]
    Markdown,
}

#[derive(Clone, Copy, Debug, ValueEnum)]
enum Mode {
    /// PDF geometry + semantic tree + optional scientific XML.
    Final,
    /// The same final fusion with native PP-DocLayoutV3 ONNX visual evidence.
    FinalOnnx,
}

#[derive(Debug, Parser)]
#[command(about = "Standalone academic PDF extraction in Rust")]
struct Args {
    /// Input PDF.
    input: PathBuf,
    /// Output file. Omit to write to stdout.
    #[arg(short, long)]
    output: Option<PathBuf>,
    #[arg(short, long, value_enum, default_value_t = Format::Json)]
    format: Format,
    /// Comma-separated 1-based pages and inclusive ranges, e.g. 1,3-5.
    #[arg(long)]
    pages: Option<String>,
    #[arg(long, env = "PDF_PASSWORD")]
    password: Option<String>,
    /// Include reconstructed source lines/spans in JSON for diagnosis.
    #[arg(long)]
    debug_lines: bool,
    /// Final extraction pipeline, with or without ONNX visual layout evidence.
    #[arg(long, value_enum, default_value_t = Mode::Final)]
    mode: Mode,
    /// PP-DocLayoutV3 ONNX file. With final-onnx, omission uses the bundled model.
    #[arg(long, value_name = "FILE", env = "OPENDATALOADER_ONNX_MODEL")]
    onnx_model: Option<PathBuf>,
    /// Minimum tree/MCID trust score for direct semantic table creation.
    #[arg(long, default_value_t = 0.9)]
    tree_trust_threshold: f32,
    /// Render one annotated PNG per selected page into this directory.
    #[arg(long, value_name = "DIRECTORY")]
    visualize: Option<PathBuf>,
    /// Bitmap scale used by --visualize (2.0 is roughly 144 DPI).
    #[arg(long, default_value_t = 2.0)]
    visualize_scale: f32,
    /// Print per-stage wall, CPU, and resident-memory metrics to stderr.
    #[arg(long)]
    profile: bool,
    /// Write the same profiling metrics as structured JSON.
    #[arg(long, value_name = "FILE")]
    metrics_output: Option<PathBuf>,
    /// Discover scientific identifiers and fetch available arXiv/PubMed/PMC XML.
    #[cfg(feature = "xml")]
    #[arg(long, value_name = "DIRECTORY")]
    fetch_xml: Option<PathBuf>,
    /// Replace cached XML files in --fetch-xml.
    #[cfg(feature = "xml")]
    #[arg(long, requires = "fetch_xml")]
    refresh_xml: bool,
    /// Contact email sent to NCBI APIs as recommended by NCBI.
    #[cfg(feature = "xml")]
    #[arg(long, env = "NCBI_EMAIL", requires = "fetch_xml")]
    ncbi_email: Option<String>,
    /// Normalized TEI or publisher JATS to reconcile with PDF tables/figures.
    #[arg(long, value_name = "FILE")]
    xml_input: Option<PathBuf>,
    /// Write a separate lossless PDF-only evidence JSON for every reconstructed table.
    #[arg(long, value_name = "FILE")]
    table_evidence_output: Option<PathBuf>,
    /// Disable final monotonic cell partitioning and exclusive text assignment.
    #[arg(long)]
    disable_table_partition_normalization: bool,
    /// Same-line span gap, in em, below which spans form one assignment sequence.
    #[arg(long, default_value_t = 0.45)]
    table_sequence_merge_gap_em: f32,
    /// Minimum orphan sequences required to create a missing table row.
    #[arg(long, default_value_t = 2)]
    table_orphan_row_min_sequences: usize,
    /// Minimum fraction of established columns touched by a missing-row candidate.
    #[arg(long, default_value_t = 0.35)]
    table_orphan_row_min_column_fraction: f32,
    /// Baseline clustering tolerance, in line heights, for missing-row candidates.
    #[arg(long, default_value_t = 0.55)]
    table_orphan_row_baseline_tolerance: f32,
    /// Local anchor clustering tolerance relative to typical column width.
    #[arg(long, default_value_t = 0.20)]
    table_local_anchor_tolerance_fraction: f32,
    /// Minimum score for assigning a text sequence to one cell.
    #[arg(long, default_value_t = 0.18)]
    table_assignment_min_score: f32,
    /// Do not infer colspans for newly recovered orphan/header rows.
    #[arg(long)]
    disable_table_orphan_spans: bool,
    /// Do not refine established cell boundaries with strong PDF vector rules.
    #[arg(long)]
    disable_table_rule_snapping: bool,
    /// Minimum table width/height fraction covered by a structural vector rule.
    #[arg(long, default_value_t = 0.70)]
    table_strong_rule_coverage_fraction: f32,
    /// Maximum rule snap distance relative to the typical row/column interval.
    #[arg(long, default_value_t = 0.55)]
    table_rule_snap_tolerance_fraction: f32,
    /// Disable span inference from original cell boxes and local separator gaps.
    #[arg(long)]
    disable_table_topology_spans: bool,
    /// Allowed bbox-to-track gap, in PDF points, when inferring a span.
    #[arg(long, default_value_t = 1.5)]
    table_span_boundary_crossing_tolerance: f32,
    /// Experimentally split a broad span that contains several aligned sequences.
    #[arg(long)]
    enable_table_overloaded_span_splitting: bool,
}

fn main() -> Result<()> {
    let args = Args::parse();
    let onnx_model = match args.mode {
        Mode::Final => None,
        Mode::FinalOnnx => Some(resolve_onnx_model(args.onnx_model.as_deref())?),
    };
    let options = ConvertOptions {
        password: args.password,
        pages: args.pages.as_deref().map(parse_pages).transpose()?,
        include_debug_lines: args.debug_lines,
        reconcile_structure: true,
        table_reconciliation: TableReconciliationMode::Fused,
        tree_trust_threshold: args.tree_trust_threshold.clamp(0.0, 1.0),
        xml_input: args.xml_input,
        onnx_model,
        table_partition: opendataloader_pdf::table_partition::TablePartitionConfig {
            enabled: !args.disable_table_partition_normalization,
            sequence_merge_gap_em: args.table_sequence_merge_gap_em.clamp(0.05, 2.0),
            orphan_row_min_sequences: args.table_orphan_row_min_sequences.max(1),
            orphan_row_min_column_fraction: args
                .table_orphan_row_min_column_fraction
                .clamp(0.0, 1.0),
            orphan_row_baseline_tolerance: args.table_orphan_row_baseline_tolerance.clamp(0.1, 2.0),
            local_anchor_tolerance_fraction: args
                .table_local_anchor_tolerance_fraction
                .clamp(0.02, 0.45),
            assignment_min_score: args.table_assignment_min_score.clamp(-1.0, 4.0),
            infer_orphan_spans: !args.disable_table_orphan_spans,
            snap_to_vector_rules: !args.disable_table_rule_snapping,
            strong_rule_coverage_fraction: args
                .table_strong_rule_coverage_fraction
                .clamp(0.25, 1.0),
            rule_snap_tolerance_fraction: args.table_rule_snap_tolerance_fraction.clamp(0.05, 1.0),
            infer_topology_spans: !args.disable_table_topology_spans,
            span_boundary_crossing_tolerance: args
                .table_span_boundary_crossing_tolerance
                .clamp(0.0, 6.0),
            split_overloaded_spans: args.enable_table_overloaded_span_splitting,
        },
    };
    let profiling = args.profile || args.metrics_output.is_some();
    let (document, mut profiler) = if profiling {
        let (document, profiler) = convert_profiled(&args.input, &options)?;
        (document, Some(profiler))
    } else {
        (convert(&args.input, &options)?, None)
    };
    if let Some(path) = &args.table_evidence_output {
        let evidence = opendataloader_pdf::table_evidence::export(
            &args.input,
            options.password.as_deref(),
            &document,
        )?;
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            fs::create_dir_all(parent)
                .with_context(|| format!("create table evidence directory {}", parent.display()))?;
        }
        fs::write(path, serde_json::to_string_pretty(&evidence)? + "\n")
            .with_context(|| format!("write table evidence {}", path.display()))?;
    }
    let before = profiler.as_ref().map(Profiler::start);
    let rendered = match args.format {
        Format::Json => serde_json::to_string_pretty(&document)? + "\n",
        Format::Markdown => to_markdown(&document),
    };
    if let (Some(profiler), Some(before)) = (profiler.as_mut(), before) {
        profiler.record("output_serialization", before);
    }
    let before = profiler.as_ref().map(Profiler::start);
    if let Some(path) = args.output {
        fs::write(&path, rendered).with_context(|| format!("write {}", path.display()))?;
    } else {
        print!("{rendered}");
    }
    if let (Some(profiler), Some(before)) = (profiler.as_mut(), before) {
        profiler.record("output_write", before);
    }
    if let Some(directory) = args.visualize {
        let mut profiler_ref = profiler.as_mut();
        let outputs = render_layout_visualizations_profiled(
            &args.input,
            options.password.as_deref(),
            &document,
            &directory,
            args.visualize_scale,
            &mut profiler_ref,
        )?;
        eprintln!(
            "wrote {} layout visualization(s) to {}",
            outputs.len(),
            directory.display()
        );
    }
    if let Some(profiler) = profiler {
        let report = profiler.report();
        if args.profile {
            print_metrics(&report);
        }
        if let Some(path) = args.metrics_output {
            fs::write(&path, serde_json::to_string_pretty(&report)? + "\n")
                .with_context(|| format!("write metrics {}", path.display()))?;
        }
    }
    #[cfg(feature = "xml")]
    if let Some(directory) = args.fetch_xml {
        let manifest = opendataloader_pdf::external_xml::fetch_for_pdf(
            &args.input,
            options.password.as_deref(),
            &document,
            &directory,
            args.ncbi_email.as_deref(),
            args.refresh_xml,
        )?;
        eprintln!("external XML: {}", serde_json::to_string_pretty(&manifest)?);
    }
    Ok(())
}

fn resolve_onnx_model(explicit: Option<&std::path::Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        if !path.is_file() {
            bail!("ONNX model not found: {}", path.display());
        }
        return Ok(path.to_owned());
    }
    #[cfg(feature = "onnx")]
    {
        let bundled = opendataloader_pdf::bundled_onnx_model_path();
        if !bundled.is_file() {
            bail!("bundled ONNX model is missing: {}", bundled.display());
        }
        return Ok(bundled);
    }
    #[cfg(not(feature = "onnx"))]
    {
        bail!("ONNX support is not compiled in; enable the `onnx` Cargo feature")
    }
}

fn print_metrics(report: &MetricsReport) {
    eprintln!(
        "{:<38} {:>5} {:>10} {:>10} {:>8} {:>11} {:>11}",
        "stage", "calls", "wall ms", "cpu ms", "cpu %", "rss after", "rss delta"
    );
    for stage in report.stages.iter().chain(std::iter::once(&report.total)) {
        eprintln!(
            "{:<38} {:>5} {:>10.2} {:>10.2} {:>7.1}% {:>10.1}M {:>+10.1}M",
            stage.stage,
            stage.calls,
            stage.wall_ms,
            stage.user_cpu_ms + stage.system_cpu_ms,
            stage.cpu_percent,
            stage.rss_after_bytes as f64 / 1_048_576.0,
            stage.rss_change_bytes as f64 / 1_048_576.0,
        );
    }
}

fn parse_pages(value: &str) -> Result<Vec<usize>> {
    let mut pages = Vec::new();
    for part in value.split(',').map(str::trim).filter(|s| !s.is_empty()) {
        if let Some((start, end)) = part.split_once('-') {
            let start: usize = start
                .parse()
                .with_context(|| format!("invalid page {start}"))?;
            let end: usize = end.parse().with_context(|| format!("invalid page {end}"))?;
            if start == 0 || end < start {
                bail!("invalid page range {part}");
            }
            pages.extend(start..=end);
        } else {
            let page: usize = part
                .parse()
                .with_context(|| format!("invalid page {part}"))?;
            if page == 0 {
                bail!("pages are 1-based");
            }
            pages.push(page);
        }
    }
    pages.sort_unstable();
    pages.dedup();
    Ok(pages)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_page_ranges() {
        assert_eq!(parse_pages("1,3-5,4").unwrap(), [1, 3, 4, 5]);
        assert!(parse_pages("4-2").is_err());
    }
}
