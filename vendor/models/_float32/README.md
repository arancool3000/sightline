# Reference weights

The originals, as published, in float32. **They are not deployed** — the
`Assemble the site` step removes this directory before publishing, so the
site downloads only the `-q` copies.

They are kept because `tests/quantize_test.cjs` compares them against the
shipped weights: without a reference there is no way to answer "did making
it smaller change what it says?", and that question needs re-answering
every time the quantiser or the models change.

Regenerate the shipped copies with:

    node tools/quantize.mjs vendor/models/_float32/coco-ssd-lite     vendor/models/coco-ssd-lite-q     float16
    node tools/quantize.mjs vendor/models/_float32/mobilenet-v1-050  vendor/models/mobilenet-v1-050-q  float16
