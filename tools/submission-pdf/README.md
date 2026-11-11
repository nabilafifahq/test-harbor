# Submission PDF builder

Builds `docs/submission.pdf` (HP-O2C-SUB-001) from recorded data. Nothing is typed in by hand: the charts and tables come from the model eval runs in `eval-runs/` (copied from the `eval-results` branch), the rules-only run in `data.json`, and the console screenshots in `shots/`.

```bash
python3 -I tools/submission-pdf/build.py   # writes tools/submission-pdf/submission.html
node tools/submission-pdf/topdf.cjs        # prints it to docs/submission.pdf (needs Playwright)
```

Set `OUT=/some/file.pdf` to print somewhere else. Playwright is not a dependency of the app; install it globally or run with `NODE_PATH` pointing at a copy that has it.

To use newer eval runs, copy their folders from the `eval-results` branch into `eval-runs/`. The three latest runs that include a `.reads.json` are reported.
