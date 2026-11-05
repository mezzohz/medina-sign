// "How did you hear about us?" on client-order-form.html (05-11-2026).
// Run: node --test tests/heard-from-form.test.mjs
// The page's own functions are lifted out of the HTML and run in a vm over a tiny fake DOM (no browser, no network).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { describe, it } from 'node:test';

const html = fs.readFileSync(new URL('../client-order-form.html', import.meta.url), 'utf8');

function fn(name) {
  const m = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\r?\\n\\}`).exec(html);
  assert.ok(m, `function ${name} not found`);
  return m[0];
}
function constant(name) {
  const m = new RegExp(`const ${name} = [\\s\\S]*?;\\r?\\n`).exec(html);
  assert.ok(m, `const ${name} not found`);
  return m[0];
}

// Fake DOM: radios live in `radios` (name -> checked value), every other element is created on demand.
function makeSandbox({ service = 'Insurance Renewal', isGroupB = false } = {}) {
  const radios = {};
  const els = {};
  const alerts = [];
  const steps = [];
  const el = (id) => (els[id] ||= { id, value: 'x', checked: false, textContent: '', style: {}, classList: { toggle() {} } });
  const document = {
    getElementById: el,
    querySelector(sel) {
      const m = /input\[name="(\w+)"\]:checked/.exec(sel);
      if (m) return radios[m[1]] === undefined ? null : { value: radios[m[1]] };
      return null;
    },
    querySelectorAll: () => []
  };
  const ctx = vm.createContext({
    document, alert: (m) => alerts.push(m), isGroupB, selectedService: service,
    goStep: (n) => steps.push(n), buildReview() {},
    getPets: () => ({ care: 'No pets', pets: null }), getMmr: () => ({}), mmrProblem: () => '',
    Object, Math
  });
  const code = [constant('HEARD_FROM_LABELS'), constant('HEARD_FROM_DETAIL_MAX'), constant('HEARD_FROM_DETAIL_LABELS'),
    fn('toggleHeardFrom'), fn('getHeardFrom'), fn('heardFromReviewText'), fn('goStep3')].join('\n');
  vm.runInContext(code, ctx);
  return { ctx, radios, el, alerts, steps };
}

// Everything else goStep3 checks for a non-hiring service is already filled by the fake DOM, so only the
// heard-from answer decides the outcome
function ready(sb) {
  sb.radios.insuranceType = 'Plan';
  return sb;
}

describe('the form markup', () => {
  it('offers exactly the five values, each with its label, as radios', () => {
    const values = [...html.matchAll(/<input type="radio" name="heardFrom" value="(\w+)"/g)].map(m => m[1]);
    assert.deepEqual(values, ['ad', 'referral', 'returning', 'search', 'other']);
    for (const label of ['Facebook or Instagram ad', 'Friend or family referred me', "I've hired from Medina before", 'Google or our website', 'Other']) {
      assert.ok(html.includes(label), label);
    }
  });
  it('is marked required and sits after the remarks, before the Review button', () => {
    assert.match(html, /How did you hear about us\? <span class="req">\*<\/span>/);
    const q = html.indexOf('How did you hear about us?');
    assert.ok(q > html.indexOf('id="remarks"'));
    assert.ok(q < html.indexOf('onclick="goStep3()"'));
  });
  it('limits the detail box to 200 characters and starts it hidden', () => {
    assert.match(html, /id="heardFromDetail" maxlength="200"/);
    assert.match(html, /id="heardFromDetailField" style="display:none/);
  });
  it('inserts both columns, NULL when empty, straight into orders (no RPC)', () => {
    assert.match(html, /heard_from: order\.heardFrom \|\| null,/);
    assert.match(html, /heard_from_detail: order\.heardFromDetail \|\| null,/);
    assert.match(html, /sbClient\.from\('orders'\)\.insert\(\[dbRow\]\)/);
  });
});

describe('validation', () => {
  it('refuses to go to the review with no answer, and says why', () => {
    const sb = ready(makeSandbox());
    sb.ctx.goStep3();
    assert.deepEqual(sb.steps, []);
    assert.equal(sb.alerts.length, 1);
    assert.match(sb.alerts[0], /how you heard about us/);
  });
  it('refuses for hiring orders too', () => {
    const sb = makeSandbox({ service: 'Direct Hiring', isGroupB: true });
    sb.radios.hiringType = 'x'; sb.radios.petCare = 'No'; sb.radios.paymentMode = 'Upfront';
    sb.ctx.goStep3();
    assert.deepEqual(sb.steps, []);
    assert.match(sb.alerts[0], /how you heard about us/);
  });
  it('goes on to the review once an answer is chosen', () => {
    const sb = ready(makeSandbox());
    sb.radios.heardFrom = 'search';
    sb.ctx.goStep3();
    assert.deepEqual(sb.alerts, []);
    assert.deepEqual(sb.steps, [3]);
  });
  it('treats a value outside the five as no answer', () => {
    const sb = ready(makeSandbox());
    sb.radios.heardFrom = 'tiktok';
    assert.equal(sb.ctx.getHeardFrom().value, '');
    sb.ctx.goStep3();
    assert.deepEqual(sb.steps, []);
  });
});

describe('the detail box', () => {
  const shows = (value) => {
    const sb = makeSandbox();
    sb.radios.heardFrom = value;
    sb.ctx.toggleHeardFrom();
    return sb.el('heardFromDetailField').style.display === 'block';
  };
  it('shows only for referral and other', () => {
    assert.deepEqual(['ad', 'referral', 'returning', 'search', 'other'].map(shows), [false, true, false, false, true]);
  });
  it('uses the right label for each', () => {
    const sb = makeSandbox();
    sb.radios.heardFrom = 'referral'; sb.ctx.toggleHeardFrom();
    assert.equal(sb.el('heardFromDetailLabel').textContent, 'Who referred you?');
    sb.radios.heardFrom = 'other'; sb.ctx.toggleHeardFrom();
    assert.equal(sb.el('heardFromDetailLabel').textContent, 'Please tell us where');
  });
  it('clears the text when the client switches to an answer without a box', () => {
    const sb = makeSandbox();
    sb.radios.heardFrom = 'referral'; sb.ctx.toggleHeardFrom();
    sb.el('heardFromDetail').value = 'a name';
    sb.radios.heardFrom = 'ad'; sb.ctx.toggleHeardFrom();
    assert.equal(sb.el('heardFromDetail').value, '');
  });
});

describe('the stored answer', () => {
  it('trims the detail and caps it at 200 characters', () => {
    const sb = makeSandbox();
    sb.radios.heardFrom = 'referral';
    sb.el('heardFromDetail').value = '   ' + 'a'.repeat(250) + '   ';
    const got = sb.ctx.getHeardFrom();
    assert.equal(got.value, 'referral');
    assert.equal(got.detail, 'a'.repeat(200));
  });
  it('never cuts an emoji in half at the 200 character limit', () => {
    const sb = makeSandbox();
    sb.radios.heardFrom = 'referral';
    sb.el('heardFromDetail').value = 'a'.repeat(199) + '😀' + 'x';
    const got = sb.ctx.getHeardFrom();
    assert.equal(got.detail, 'a'.repeat(199) + '😀');
    assert.ok(got.detail.isWellFormed(), 'a lone surrogate would make Postgres refuse the whole order');
  });
  it('drops any detail typed for an answer that has no box', () => {
    const sb = makeSandbox();
    sb.radios.heardFrom = 'search';
    sb.el('heardFromDetail').value = 'stray text';
    assert.deepEqual({ ...sb.ctx.getHeardFrom() }, { value: 'search', detail: '' });
  });
  it('escapes a hostile detail in the review table', () => {
    const sb = makeSandbox();
    sb.radios.heardFrom = 'other';
    sb.el('heardFromDetail').value = '<img src=x onerror=alert(1)> & co';
    const text = sb.ctx.heardFromReviewText();
    assert.ok(!text.includes('<img'));
    assert.match(text, /&lt;img src=x onerror=alert\(1\)&gt; &amp; co/);
  });
});
