const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

const OLD_SUNDAY_TIMES = [
  /10:00\s*AM/i,
  /1:00\s*PM/i,
  /10:00 AM y 1:00 PM/,
  /10:00 AM &amp; 1:00 PM/,
  /10:00 AM & 1:00 PM/,
];

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('homepage uses one Sunday service at 11:00 AM in Spanish and English', () => {
  const html = read('index.html');

  assert.match(html, /Domingos 11:00 AM, Celebración Jueves 7:30 PM/);
  assert.match(
    html,
    /Celebración Domingos · 11:00 AM &nbsp;—&nbsp; Fundamentos de Fe Jueves · 7:30 PM/
  );
  assert.match(
    html,
    /Celebration Sundays · 11:00 AM &nbsp;—&nbsp; Fundamentos de Fe Thursdays · 7:30 PM/
  );
  assert.match(html, /Domingos<\/span><span data-lang-en>Sundays<\/span> · 11:00 AM/);
  assert.match(
    html,
    /Celebración Jueves<\/span><span data-lang-en>Thursday Celebration<\/span> · 7:30 PM/
  );
  assert.match(html, /Fundamentos de Fe Jueves · 7:30 PM/);
  assert.match(html, /Fundamentos de Fe Thursdays · 7:30 PM/);

  const sundayLines = html
    .split('\n')
    .filter((line) => /Domingo|Sunday/i.test(line) && /\d{1,2}:\d{2}\s*AM/.test(line));
  assert.ok(sundayLines.length >= 4, 'expected Sunday times on hero, visit, footer, and SEO');
  for (const line of sundayLines) {
    assert.match(line, /11:00 AM/);
    assert.doesNotMatch(line, /(?<!\d)10:00|(?<!\d)1:00/);
  }
  for (const pattern of OLD_SUNDAY_TIMES) {
    assert.doesNotMatch(html, pattern);
  }
});

test('about page footer uses one Sunday service at 11:00 AM', () => {
  const html = read('about.html');
  assert.match(
    html,
    /Celebración Domingos<\/span><span data-lang-en>Celebration Sundays<\/span> · 11:00 AM/
  );
  assert.match(
    html,
    /Fundamentos de Fe Jueves<\/span><span data-lang-en>Fundamentos de Fe Thursdays<\/span> · 7:30 PM/
  );
  for (const pattern of OLD_SUNDAY_TIMES) {
    assert.doesNotMatch(html, pattern);
  }
});

test('events, livestream, and sermons do not encode a second Sunday service', () => {
  const sources = ['index.html', 'about.html', 'api/livestream.js', 'api/sermons.js', 'vercel.json', 'README.md'];
  for (const rel of sources) {
    const text = read(rel);
    for (const pattern of OLD_SUNDAY_TIMES) {
      assert.doesNotMatch(text, pattern, `${rel} still has an old Sunday time`);
    }
  }
});
