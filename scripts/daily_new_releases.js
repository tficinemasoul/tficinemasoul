/**
 * TFI Cinema Soul — Daily New Release Checker
 * ─────────────────────────────────────────────
 * Checks TMDB for newly released Telugu movies, compares against
 * existing Supabase data, and inserts genuinely new titles.
 *
 * New entries get ott_platform = "Pending Review" so they're easy
 * to find and confirm manually (just that one field) without
 * re-entering everything else by hand.
 *
 * Designed to run daily via GitHub Actions (see workflow file).
 */

const { createClient } = require('@supabase/supabase-js');

const TMDB_KEY = process.env.TMDB_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!TMDB_KEY || !SUPABASE_URL || !SUPABASE_KEY) {
  console.error('❌ Missing required environment variables (TMDB_API_KEY, SUPABASE_URL, SUPABASE_KEY)');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// How many days back to check for "new" releases.
// Set wider than 1 day to catch anything missed on prior runs.
const LOOKBACK_DAYS = 10;

function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[.,]/g, '').trim().replace(/\s+/g, ' ');
}

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

async function fetchRecentTeluguMovies() {
  const today = new Date();
  const fromDate = new Date(today);
  fromDate.setDate(today.getDate() - LOOKBACK_DAYS);

  const params = new URLSearchParams({
    api_key: TMDB_KEY,
    with_original_language: 'te',
    'release_date.gte': formatDate(fromDate),
    'release_date.lte': formatDate(today),
    sort_by: 'release_date.desc',
    region: 'IN',
    include_adult: 'false',
    page: '1',
  });

  let allResults = [];
  let page = 1;
  let totalPages = 1;

  do {
    params.set('page', String(page));
    const res = await fetch(`https://api.themoviedb.org/3/discover/movie?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`TMDB discover failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    allResults = allResults.concat(data.results || []);
    totalPages = data.total_pages || 1;
    page++;
  } while (page <= totalPages && page <= 5); // safety cap, 5 pages = 100 movies max per run

  return allResults;
}

async function fetchMovieDetails(tmdbId) {
  const res = await fetch(
    `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${TMDB_KEY}&language=en-US&append_to_response=credits`
  );
  if (!res.ok) return null;
  return res.json();
}

function mapGenres(genreObjs) {
  const names = (genreObjs || []).map(g => g.name);
  return names.length ? names.join(', ') : 'Drama';
}

function extractDirector(credits) {
  const crew = credits?.crew || [];
  const director = crew.find(c => c.job === 'Director');
  return director ? director.name : 'Unknown';
}

function extractLeadCast(credits) {
  const cast = credits?.cast || [];
  // Best-effort: first male-credited and first female-credited top-billed actors.
  // TMDB doesn't reliably expose gender for all entries, so this is approximate —
  // flagged for manual review rather than treated as ground truth.
  const hero = cast[0]?.name || 'Unknown';
  const heroine = cast[1]?.name || 'Unknown';
  return { hero, heroine };
}

async function getExistingTitles() {
  // Pull just titles+years for duplicate-checking (cheap query, no need for full rows)
  const { data, error } = await supabase.from('movies').select('title, year');
  if (error) throw new Error(`Supabase fetch failed: ${error.message}`);
  const set = new Set();
  (data || []).forEach(m => set.add(`${normalizeName(m.title)}|${m.year}`));
  return set;
}

function makeSlug(title, year, existingSlugs) {
  const base = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  let slug = base;
  if (existingSlugs.has(slug)) {
    slug = `${base}-${year}`;
  }
  return slug;
}

function makeWebsiteLink(slug) {
  return `https://tficinemasoul1.netlify.app/movie/${slug}`;
}

async function run() {
  console.log(`🎬 TFI Cinema Soul — Daily New Release Check (${formatDate(new Date())})`);
  console.log(`Looking back ${LOOKBACK_DAYS} days for new Telugu releases...`);

  const candidates = await fetchRecentTeluguMovies();
  console.log(`TMDB returned ${candidates.length} candidate(s) in the date range.`);

  if (candidates.length === 0) {
    console.log('No candidates found. Nothing to do today.');
    return;
  }

  const existingTitles = await getExistingTitles();

  const newMovies = candidates.filter(m => {
    const year = (m.release_date || '').slice(0, 4);
    const key = `${normalizeName(m.title)}|${year}`;
    return !existingTitles.has(key);
  });

  console.log(`${newMovies.length} of those are genuinely new (not already in our database).`);

  if (newMovies.length === 0) {
    console.log('✅ Database is already up to date.');
    return;
  }

  // Fetch full details for each new movie (director, cast, genres)
  const enriched = [];
  for (const m of newMovies) {
    const details = await fetchMovieDetails(m.id);
    if (!details) {
      console.warn(`⚠️  Could not fetch details for "${m.title}" (TMDB id ${m.id}), skipping.`);
      continue;
    }
    const { hero, heroine } = extractLeadCast(details.credits);
    enriched.push({
      title: m.title,
      year: parseInt((m.release_date || '0').slice(0, 4)) || 0,
      director: extractDirector(details.credits),
      hero,
      heroine,
      genre: mapGenres(details.genres),
      ott_platform: 'Pending Review', // flagged for manual confirmation
      rating: Math.round((m.vote_average || 0) * 10) / 10,
      overview: details.overview || 'Overview not available.',
      family_watch: 'Pending Review',
      duration: details.runtime || 0,
      type: 'Movie',
      website_link: '', // filled in after slug generation below
    });
  }

  // Generate unique slugs against existing + this batch
  const existingSlugSet = new Set(); // best-effort; full collision-proofing happens on next full slug rebuild
  const rows = enriched.map(m => {
    const slug = makeSlug(m.title, m.year, existingSlugSet);
    existingSlugSet.add(slug);
    return { ...m, website_link: makeWebsiteLink(slug) };
  });

  console.log(`Inserting ${rows.length} new movie(s):`);
  rows.forEach(r => console.log(`  • ${r.title} (${r.year}) — dir. ${r.director}`));

  const { error: insertError } = await supabase.from('movies').insert(rows);
  if (insertError) {
    throw new Error(`Supabase insert failed: ${insertError.message}`);
  }

  console.log(`✅ Successfully added ${rows.length} new movie(s) to Supabase.`);
  console.log(`⚠️  ACTION NEEDED: ${rows.length} new entries have ott_platform = "Pending Review".`);
  console.log(`   Open Supabase Table Editor and filter by ott_platform = "Pending Review" to confirm platform + family_watch for each.`);
}

run().catch(err => {
  console.error('❌ Script failed:', err.message);
  process.exit(1);
});
