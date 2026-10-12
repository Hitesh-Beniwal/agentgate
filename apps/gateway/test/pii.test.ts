import { test } from "node:test";
import assert from "node:assert/strict";
import { redactText, luhnValid, tfnValid, medicareValid } from "../src/pii.js";

test("redacts Australian mobile and landline numbers", () => {
  const { text, counts } = redactText("Call 0412 345 678, +61 431 222 333 or (03) 9123 4567");
  assert.equal(counts.PHONE_AU, 3);
  assert.ok(!/\d{3} \d{3}/.test(text));
});

test("redacts emails", () => {
  const { text, counts } = redactText("Contact jane.citizen@example.com today");
  assert.equal(text, "Contact [EMAIL_REDACTED] today");
  assert.equal(counts.EMAIL, 1);
});

test("redacts Luhn-valid card numbers only", () => {
  assert.equal(redactText("Card 4111 1111 1111 1111").counts.CREDIT_CARD, 1);
  assert.equal(redactText("Order 4111 1111 1111 1112").counts.CREDIT_CARD, undefined);
});

test("checksum validators", () => {
  assert.equal(luhnValid("4111111111111111"), true);
  assert.equal(luhnValid("4111111111111112"), false);
  assert.equal(tfnValid("123 456 782"), true);
  assert.equal(tfnValid("123 456 789"), false);
  assert.equal(medicareValid("2123 45670 1"), true);
  assert.equal(medicareValid("2123 45679 1"), false);
});

test("redacts valid TFN and Medicare numbers", () => {
  const { counts } = redactText("TFN 123 456 782, Medicare 2123 45670 1");
  assert.equal(counts.TFN, 1);
  assert.equal(counts.MEDICARE, 1);
});

test("leaves normal numbers alone (no false positives)", () => {
  const input = "Invoice 2024-118 for $385000, order 12345, postcode 3000, ABN-free text";
  const { text, counts } = redactText(input);
  assert.equal(text, input);
  assert.deepEqual(counts, {});
});
