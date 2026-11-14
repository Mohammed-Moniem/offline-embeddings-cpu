import test from 'node:test';
import assert from 'node:assert/strict';
import { EmbeddingEngine } from '../src/embedding.mjs';

test('one unknown token spanning a huge word does not create thousands of overlapping chunks', () => {
  const engine = new EmbeddingEngine();
  let tokenizerCalls = 0;
  engine.extractor = {
    tokenizer: {
      encode() {
        tokenizerCalls += 1;
        // A buggy chunker would advance one character and keep invoking the
        // tokenizer. Fail promptly instead of constructing megabytes of duplicates.
        assert.ok(tokenizerCalls < 1000, 'Chunking is not making useful progress through the unknown word');
        return [101, 100, 102]; // [CLS], [UNK], [SEP]
      },
    },
  };
  const text = 'abcdefghij'.repeat(2000);
  const chunks = engine.chunk(text, { maxTokens: 384, overlapTokens: 48 });
  assert.ok(chunks.length > 0 && chunks.length <= 4, `Expected at most four chunks for 20,000 characters; got ${chunks.length}`);
  let coveredUntil = 0;
  let previousStart = -1;
  for (const chunk of chunks) {
    assert.ok(chunk.start > previousStart, 'Chunk start must advance');
    assert.ok(chunk.end > coveredUntil, 'Each chunk must cover new source text');
    assert.ok(chunk.start <= coveredUntil, 'Chunking must not omit source characters');
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    assert.equal(chunk.tokens, 3);
    previousStart = chunk.start;
    coveredUntil = chunk.end;
  }
  assert.equal(coveredUntil, text.length, 'Chunking must cover the entire huge word');
});
