/**
 * TFI Cinema Soul — Daily OTT Platform Confirmation
 * ─────────────────────────────────────────────────────
 * Finds movies still marked "Pending Review" and attempts to confirm
 * their real OTT platform using live web search (Serper API).
 *
 * IMPORTANT DESIGN PRINCIPLE: this script only ever writes a platform
 * name when it finds a CONFIDENT, EXPLICIT match. If no confident
 * match is found, the movie is left as "Pending Review" for next
 * run — we never guess, because a wrong "Watch Now" link is
 * worse than no link at all.
 *
 * Runs daily via GitHub Actions. Free Serper tier (2,500/month) is
 * comfortably enough for typical pending-list sizes at this frequency.
 */

const { createClient } = require('@supabase/supabase-js');

const SERPER_KEY = process.env.SERPER_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SERPER_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing required environment variables (SERPER_API_KEY, SUPABASE_URL, SUPABASE_KEY)');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Canonical platform names we recognize, and the phrases that count as
// a confident textual match for each. Order matters only for display.
const PLATFORM_PATTERNS = [
  { name: 'Aha', patterns: ['aha video', 'on aha', 'aha original', 'streaming on aha'] },
  { name: 'Prime Video', patterns: ['amazon prime video', 'prime video', 'on prime'] },
  { name: 'Netflix', patterns: ['netflix'] },
  { name: 'Sun NXT', patterns: ['sun nxt', 'sunnxt'] },
  { name: 'ZEE5', patterns: ['zee5', 'zee 5'] },
  { name: 'SonyLIV', patterns: ['sonyliv', 'sony liv'] },
];

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[.,]/g, '').trim().replace(/\s+/g, ' ');
}

async function getPendingMovies() {
  const { data, error } = await supabase
    .from('movies')
    .select('id, title, year')
    .eq('ott_platform', 'Pending Review');
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  return data || [];
}

async function searchForMovie(title, year) {
  const query = `"${title}" ${year} Telugu OTT release Aha Prime Video Netflix ZEE5 SunNXT SonyLIV`;
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': SERPER_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ q: query, num: 10 }),
  });
  if (!res.ok) {
    throw new Error(`Serper search failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Looks for a confident match: the movie title must appear in the
 * result text (title or snippet), AND a recognized platform name must
 * also appear in that SAME result. Returns the first confident match,
 * or null if nothing meets the bar.
 */
function findConfidentMatch(searchResults, movieTitle) {
  const normalizedTitle = normalizeName(movieTitle);
  const titleWords = normalizedTitle.split(' ').filter(w => w.length > 2);

  const allItems = [
    ...(searchResults.organic || []),
    ...(searchResults.news || []),
  ];

  for (const item of allItems) {
    const text = normalizeName(`${item.title || ''} ${item.snippet || ''}`);

    // Require most of the title's significant words to appear —
    // avoids matching a generic article that just happens to mention a platform.
    const titleWordsPresent = titleWords.filter(w => text.includes(w)).length;
    const titleMatchRatio = titleWords.length > 0 ? titleWordsPresent / titleWords.length : 0;
    if (titleMatchRatio < 0.7) continue;

    for (const platform of PLATFORM_PATTERNS) {
      if (platform.patterns.some(p => text.includes(p))) {
        return { platform: platform.name, source: item.link || item.title, snippet: item.snippet };
      }
    }
  }
  return null;
}

async function run() {
  console.log(`🔍 TFI Cinema Soul — Daily OTT Platform Confirmation (${new Date().toISOString().split('T')[0]})`);

  const pending = await getPendingMovies();
  console.log(`Found ${pending.length} movie(s) marked "Pending Review".`);

  if (pending.length === 0) {
    console.log('✅ Nothing pending. All caught up.');
    return;
  }

  let confirmedCount = 0;
  let stillPendingCount = 0;

  for (const movie of pending) {
    console.log(`\n— Checking "${movie.title}" (${movie.year})...`);
    try {
      const results = await searchForMovie(movie.title, movie.year);
      const match = findConfidentMatch(results, movie.title);

      if (match) {
        console.log(`  ✅ Confident match found: ${match.platform}`);
        console.log(`     Source: ${match.source}`);

        const { error: updateError } = await supabase
          .from('movies')
          .update({ ott_platform: match.platform })
          .eq('id', movie.id);

        if (updateError) {
          console.error(`  ❌ Failed to update Supabase: ${updateError.message}`);
        } else {
          confirmedCount++;
        }
      } else {
        console.log(`  ⏳ No confident match yet — likely not released digitally. Leaving as Pending Review.`);
        stillPendingCount++;
      }
    } catch (err) {
      console.error(`  ⚠️  Error checking "${movie.title}": ${err.message}`);
      stillPendingCount++;
    }

    // Small delay between requests to be a polite API citizen
    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`\n📊 Summary: ${confirmedCount} confirmed, ${stillPendingCount} still pending.`);
  if (confirmedCount > 0) {
    console.log(`✅ ${confirmedCount} movie(s) updated with real OTT platform data.`);
  }
  if (stillPendingCount > 0) {
    console.log(`⏳ ${stillPendingCount} movie(s) still pending — will retry tomorrow. This is expected for very recent releases (Telugu films typically take 4-8 weeks to reach OTT).`);
  }

  // Note: family_watch is intentionally NOT auto-resolved here.
  // That's a subjective content judgment, not a factual lookup,
  // so it stays a manual field even after the platform is confirmed.
}

run().catch(err => {
  console.error('❌ Script failed:', err.message);
  process.exit(1);
});
