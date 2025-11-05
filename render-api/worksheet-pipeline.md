# Worksheet Processing Pipeline

This document describes how to use the worksheet-processing pipeline implemented in `worksheet-pipeline.js`. The goal of the pipeline is to transform an uploaded worksheet into enriched problem objects that include diagram analysis, answers, explanations, and metadata.

## Overview

The pipeline is composed of the following stages (executed in order):

1. **Upload** — Read the worksheet file (PDF or image) from disk.
2. **Mathpix extraction** — Send the file to Mathpix and poll until structured problem data is returned.
3. **Routing** — For each extracted problem, determine whether a diagram is present.
4. **Vision (conditional)** — If a diagram is detected for a problem, use OpenAI Vision to obtain semantic data (`visual_context`). Text-only problems skip this step.
5. **LLM answer generation** — Call the standard LLM with the problem (and `visual_context` when available) to generate `answer`, `explanation`, and optional metadata.
6. **Output assembly** — Return an array of enriched problem objects while preserving the original problem ordering.

Each problem is processed independently and in parallel where it is safe to do so.

## File structure

```
render-api/
  worksheet-pipeline.js       # Main orchestrator and modules
  worksheet-pipeline.md       # This guide
```

## Environment variables

The pipeline relies on the following environment variables. Set them before running the script:

| Variable                | Description                                    |
|-------------------------|------------------------------------------------|
| `MATHPIX_APP_ID`        | Mathpix application ID                         |
| `MATHPIX_APP_KEY`       | Mathpix application key                        |
| `OPENAI_API_KEY`        | OpenAI API key (used for both Vision and LLM)  |
| `OPENAI_VISION_MODEL`   | (Optional) Overrides the default Vision model  |
| `OPENAI_TEXT_MODEL`     | (Optional) Overrides the default LLM model     |

## Usage

```
node render-api/worksheet-pipeline.js <path-to-worksheet>
```

The script prints the enriched problem array as JSON to stdout. Individual problem errors are included in the output but do not abort the entire batch.

## Key behaviors

- **Parallelism**
  - Mathpix returns all problems for the worksheet; after that, each problem is processed in parallel (Vision and LLM).
  - Vision is invoked only when `needsVision(problem)` returns true.

- **Resilience**
  - Network calls use `withRetry` (exponential backoff) plus `withTimeout`.
  - Vision and LLM invocations include logging for retries and timing.
  - Errors are captured per problem. The result object includes an `error` field, while other problems continue processing.

- **Logging**
  - Per-problem logs show routing decisions (“text-only” vs “diagram detected”), vision/LLM timing, and total elapsed time.

- **Data hygiene**
  - Raw worksheet images are sent only to Mathpix and, conditionally, to OpenAI Vision (never directly to the standard LLM).
  - The final output contains the following keys when available: `instruction`, `text`, `latex`, `options`, `visual_context`, `answer`, `explanation`, `topic`, `difficulty`, `error`, `page`, `index`.

- **Preserved ordering**
  - Final results maintain the same order as they were returned from Mathpix.

## Extensibility

- Swap the `needsVision` heuristic to better match Mathpix data.
- Replace the logging implementation (`createLogger`) or inject your own logger.
- Adjust retry/backoff parameters as needed via helper functions.
- The orchestrator `processWorksheet` can be imported and used programmatically:

  ```js
  const { processWorksheet } = require('./worksheet-pipeline');

  const results = await processWorksheet('/path/to/worksheet.pdf', {
    timeoutMs: 45000,
    logger: customLogger
  });
  ```

## Limitations

- The script expects Mathpix to return structured problem data. If the job never completes, a timeout error is thrown.
- Diagram detection is heuristic-based; adjust `needsVision(problem)` for your schema.
- The example Vision prompt extracts semantics into text; transform it into structured JSON if desired.

## Persisting results to MongoDB

Call `persistWorksheetResults(results, { worksheetId, lessonSlug })` after `processWorksheet` to upsert output into MongoDB.
It uses `MONGODB_URI` and writes to `WORKSHEET_RESULTS_DB` / `WORKSHEET_RESULTS_COLLECTION` (defaults: `thinkpod.worksheet_results`).
Each document stores `answer`, `explanation`, `visual_context`, and any per-problem errors.
Set the env `WORKSHEET_RESULTS_STORE=1` when running the CLI to automatically persist using an optional `WORKSHEET_LESSON_SLUG`.

Example:
```js
const { processWorksheet, persistWorksheetResults } = require('./worksheet-pipeline');

const results = await processWorksheet('/path/to/file.pdf');
await persistWorksheetResults(results, { worksheetId: 'ws123', lessonSlug: 'lesson-1' });
```
