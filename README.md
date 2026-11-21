# csv-reader-speed-01 — a faster csv-reader 1.0.0

A drop-in replacement for csv-reader 1.0.0 (make.fun's own reference CSV reader) that
returns exactly the same answer for every input, in much less CPU time.

## What it does

`solve.js` exports `run(input)`, which reads `{text, header}` exactly as csv-reader 1.0.0
does and returns `{columns, rows, errors}`: the header (or `null`), every other record as
an array of strings at the first record's width, and every broken thing met, in order.
The broken-row policy is csv-reader's own: BOM dropped, LF/CRLF record ends, empty lines
are no record, stray CRs dropped (`stray_cr`), quoted fields with `""` escapes and CR/LF
inside read as LF, junk after a closing quote appended (`quote_junk`), a quote that never
closes read as a literal with the rest re-read as unquoted (`unterminated_quote`), short
rows padded (`short_row`) and long rows cut (`long_row`). Fields stay strings, never
trimmed or converted.

`main.ts` is the program the harness runs: it reads every case from `/input/cases.json`,
answers each one alone with `run`, and writes `/output/answers.json`.

## How it is fast

The reference walks the text one character at a time, building every field with `+=`.
This reader works in slices instead:

- Most records are plain lines (no quote, no stray CR): one line is found with
  `indexOf('\n')` and split on `,` in a single C++ pass.
- Records that do hold a quote or a stray CR take a careful path driven by two small
  regexes (`/[,\r\n]/` and `/["\r\n]/`) that each find the next special character in one
  scan, so the text is never walked character by character and never scanned twice over
  the same stretch.

Pure and deterministic: no clock, no randomness, no state kept between calls, no
dependencies, no network. `main.ts` turns V8's incremental marking off before importing
`solve.js`, as the house baseline does.

## Local results (practice set, 6 cases, ~10.2 MB of CSV)

- Correctness: 6/6 cases identical to `practice/reference/expected.json`
- CPU time for `run` over the whole set: ~170–200 ms, against ~650–820 ms for
  csv-reader 1.0.0 itself on the same machine (about 3.5× faster)
- Also verified 6/6 on two freshly drawn instances from the kit's own generator
  (different seeds), and 0 mismatches across 7,140 differential fuzz checks against
  the reference, including unterminated quotes, stray CRs, quote junk, blank lines,
  BOM, and empty inputs.

## Layout

- `solve.js` — the reader (`run`)
- `main.ts` — the harness program
- `package.json` — `{"type": "module"}`
- `LICENSE` — MIT
- `.makefun/owner.json` — the payout wallet
