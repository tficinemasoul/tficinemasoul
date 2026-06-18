const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const { message } = JSON.parse(event.body);
    const GEMINI_KEY = process.env.GEMINI_API_KEY;
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_KEY;

    if (!GEMINI_KEY) {
      return { statusCode: 200, headers, body: JSON.stringify({ reply: 'Error: GEMINI_API_KEY not set.' }) };
    }
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return { statusCode: 200, headers, body: JSON.stringify({ reply: 'Error: Supabase credentials not set.' }) };
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
    const geminiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_KEY;

    // ───────────────────────────────────────────────────────────
    // STEP 1: Try LOCAL keyword matching first (no API call)
    // ───────────────────────────────────────────────────────────
    const msgLower = message.toLowerCase();

    const HERO_ALIASES = {
      'prabhas': ['prabhas', 'prabas', 'prabhash', 'prabhaas'],
      'mahesh babu': ['mahesh babu', 'mahesh', 'mahes', 'maheshbabu', 'mahesbabu'],
      'pawan kalyan': ['pawan kalyan', 'pawan', 'powan kalyan', 'pavan kalyan'],
      'jr ntr': ['jr ntr', 'jr.ntr', 'ntr jr', 'tarak', 'ntr'],
      'allu arjun': ['allu arjun', 'aluarjun', 'bunny', 'allu arju'],
      'ram charan': ['ram charan', 'ramcharan', 'cherry'],
      'chiranjeevi': ['chiranjeevi', 'chiranjeevy', 'chiru'],
      'vijay deverakonda': ['vijay deverakonda', 'vijay devarakonda', 'rowdy vijay'],
      'nani': ['nani'],
      'ravi teja': ['ravi teja', 'raviteja', 'ravithez'],
      'nagarjuna': ['nagarjuna', 'nag'],
      'venkatesh': ['venkatesh', 'venky'],
      'balakrishna': ['balakrishna', 'balayya', 'bala krishna'],
      'sai dharam tej': ['sai dharam tej', 'saidharam'],
      'nithiin': ['nithiin', 'nithin'],
      'sharwanand': ['sharwanand', 'sharwa'],
      'vishwak sen': ['vishwak sen', 'vishwaksen'],
      'sudheer babu': ['sudheer babu', 'sudheerbabu'],
      'ram pothineni': ['ram pothineni', 'rampo'],
      'adivi sesh': ['adivi sesh', 'adivisesh'],
    };

    const GENRE_KEYWORDS = {
      'thriller': ['thriller', 'thrillers', 'thrilling'],
      'action': ['action'],
      'comedy': ['comedy', 'comedies', 'funny'],
      'romance': ['romance', 'romantic', 'love story', 'love stories'],
      'horror': ['horror', 'scary', 'ghost'],
      'drama': ['drama', 'dramas'],
      'family': ['family drama', 'family movie'],
      'crime': ['crime'],
      'mystery': ['mystery', 'mysteries'],
      'fantasy': ['fantasy'],
      'biography': ['biography', 'biopic'],
      'sports': ['sports', 'sport'],
    };

    const OTT_KEYWORDS = {
      'Aha': ['aha'],
      'Prime Video': ['prime video', 'prime', 'amazon prime', 'amazon'],
      'Netflix': ['netflix'],
      'Sun NXT': ['sun nxt', 'sunnxt', 'sun next'],
      'ZEE5': ['zee5', 'zee 5'],
      'SonyLIV': ['sonyliv', 'sony liv', 'sony'],
    };

    let filters = { limit: 8 };

    for (const [canonical, aliases] of Object.entries(HERO_ALIASES)) {
      if (aliases.some(a => msgLower.includes(a))) {
        filters.hero = canonical;
        break;
      }
    }

    for (const [canonical, aliases] of Object.entries(GENRE_KEYWORDS)) {
      if (aliases.some(a => msgLower.includes(a))) {
        filters.genre = canonical;
        break;
      }
    }

    for (const [canonical, aliases] of Object.entries(OTT_KEYWORDS)) {
      if (aliases.some(a => msgLower.includes(a))) {
        filters.ott_platform = canonical;
        break;
      }
    }

    const yearMatch = message.match(/\b(19[5-9]\d|20[0-2]\d)\b/);
    if (yearMatch) filters.year = parseInt(yearMatch[0]);

    if (msgLower.includes('family') && (msgLower.includes('watch') || msgLower.includes('movie') || msgLower.includes('ga'))) {
      filters.family_watch = 'Yes';
    }

    if (msgLower.includes('series') || msgLower.includes('web series')) {
      filters.type = 'Series';
    } else if (msgLower.includes('movie') && !msgLower.includes('series')) {
      filters.type = 'Movie';
    }

    const limitMatch = msgLower.match(/(?:top|best)\s*(\d+)/);
    if (limitMatch) {
      const n = parseInt(limitMatch[1]);
      if (n > 0 && n <= 30) filters.limit = n;
    }

    // ───────────────────────────────────────────────────────────
    // STEP 1b: Detect if the message LIKELY mentions a person's name
    // that our alias list failed to catch. If so, and only then,
    // use one small Gemini call to identify it correctly.
    // ───────────────────────────────────────────────────────────
    // Heuristic: message contains a word with capital letter pattern,
    // OR contains generic person-indicating words, but no hero/heroine/
    // director was matched locally yet.
    const STOPWORDS = ['best','top','good','nice','movies','movie','series','show',
      'shows','on','in','the','a','an','is','are','of','for','to','me','my',
      'please','give','show','tell','list','want','recommend','suggest',
      'family','watch','telugu','film','films','aha','prime','netflix',
      'sun','nxt','zee5','sonyliv','2024','2025','2023','2022','2021','2020',
      'thriller','thrillers','thrilling','action','comedy','comedies','funny',
      'romance','romantic','love','story','stories','horror','scary','ghost',
      'drama','dramas','crime','mystery','mysteries','fantasy','biography',
      'biopic','sports','sport','rated','rating','ratings','recommend',
      'recommendation','recommendations','suggestion','suggestions'];

    const words = msgLower.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
    const unknownWords = words.filter(w => w.length > 3 && !STOPWORDS.includes(w));

    const noNameMatchedYet = !filters.hero && !filters.heroine && !filters.director;
    const looksLikeNameMightBePresent = unknownWords.length > 0 && noNameMatchedYet;

    if (looksLikeNameMightBePresent) {
      // Small, cheap Gemini call - ONLY to identify a likely actor/director name
      const nameCheckPrompt = "A user is searching a Telugu movie database. Their message might contain "
        + "a misspelled actor, actress, or director name that doesn't match common spellings.\n"
        + "Message: \"" + message + "\"\n\n"
        + "If the message contains a person's name (even misspelled), respond with ONLY that corrected "
        + "full name in lowercase (e.g. \"nithiin\" or \"jr ntr\" or \"trivikram srinivas\").\n"
        + "If there is NO person's name in the message, respond with exactly: none\n"
        + "Respond with nothing else - just the name or the word none.";

      try {
        const nameCheckRes = await fetch(geminiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: nameCheckPrompt }] }],
            generationConfig: { temperature: 0, maxOutputTokens: 30 }
          })
        });

        if (nameCheckRes.ok) {
          const nameCheckData = await nameCheckRes.json();
          const nameCandidate = nameCheckData.candidates && nameCheckData.candidates[0] && nameCheckData.candidates[0].content
            ? nameCheckData.candidates[0].content.parts[0].text.trim().toLowerCase().replace(/[."]/g, '')
            : 'none';

          if (nameCandidate && nameCandidate !== 'none' && nameCandidate.length > 2) {
            // We don't know if it's hero, heroine, or director - try hero first (most common ask)
            filters.hero = nameCandidate;
          }
        }
      } catch (e) {
        // If this extra check fails for any reason, just continue without it
      }
    }

    // ───────────────────────────────────────────────────────────
    // STEP 2: Query Supabase using extracted filters
    // ───────────────────────────────────────────────────────────
    let query = supabase
      .from('movies')
      .select('title, year, director, hero, heroine, genre, ott_platform, rating, family_watch, type, website_link')
      .order('rating', { ascending: false });

    if (filters.genre) query = query.ilike('genre', '%' + filters.genre + '%');
    if (filters.hero) query = query.ilike('hero', '%' + filters.hero + '%');
    if (filters.heroine) query = query.ilike('heroine', '%' + filters.heroine + '%');
    if (filters.director) query = query.ilike('director', '%' + filters.director + '%');
    if (filters.ott_platform) query = query.ilike('ott_platform', '%' + filters.ott_platform + '%');
    if (filters.year) query = query.eq('year', filters.year);
    if (filters.type) query = query.ilike('type', filters.type);
    if (filters.family_watch) query = query.ilike('family_watch', filters.family_watch);

    const resultLimit = filters.limit || 8;
    query = query.limit(Math.max(resultLimit * 3, 30));

    const { data: movies, error } = await query;

    if (error) {
      return { statusCode: 200, headers, body: JSON.stringify({ reply: 'Database error: ' + error.message }) };
    }

    // Precise word-boundary filter to remove false positives
    // e.g. searching "Prabhas" should not match "Sumanth Prabhas"
    function normalizeName(s) {
      return s.toLowerCase().replace(/[.,]/g, '').trim().split(/\s+/);
    }
    function isPreciseNameMatch(fieldValue, searchName) {
      if (!fieldValue || !searchName) return true;
      var fvWords = normalizeName(fieldValue);
      var snWords = normalizeName(searchName);
      if (fvWords.length !== snWords.length) return false;
      for (var i = 0; i < fvWords.length; i++) {
        if (fvWords[i] !== snWords[i]) return false;
      }
      return true;
    }

    var movies2 = movies;
    var hadHeroResultsBeforeStrictFilter = false;
    if (filters.hero && movies2) {
      hadHeroResultsBeforeStrictFilter = movies2.length > 0;
      var exactMatches = movies2.filter(function(m) { return isPreciseNameMatch(m.hero, filters.hero); });
      if (exactMatches.length > 0) movies2 = exactMatches;
    }
    if (filters.heroine && movies2) {
      var exactMatchesH = movies2.filter(function(m) { return isPreciseNameMatch(m.heroine, filters.heroine); });
      if (exactMatchesH.length > 0) movies2 = exactMatchesH;
    }

    let finalMovies = movies2;
    let usedFallback = false;

    // If our Gemini-identified name still found nothing, try heroine field too before giving up
    if ((!finalMovies || finalMovies.length === 0) && filters.hero) {
      const { data: heroineTry } = await supabase
        .from('movies')
        .select('title, year, director, hero, heroine, genre, ott_platform, rating, family_watch, type, website_link')
        .ilike('heroine', '%' + filters.hero + '%')
        .order('rating', { ascending: false })
        .limit(30);
      if (heroineTry && heroineTry.length > 0) {
        finalMovies = heroineTry.filter(function(m) { return isPreciseNameMatch(m.heroine, filters.hero); });
        if (finalMovies.length === 0) finalMovies = heroineTry;
      }
    }

    if (!finalMovies || finalMovies.length === 0) {
      usedFallback = true;
      const { data: fallbackMovies } = await supabase
        .from('movies')
        .select('title, year, director, hero, heroine, genre, ott_platform, rating, family_watch, type, website_link')
        .order('rating', { ascending: false })
        .limit(30);
      finalMovies = fallbackMovies || [];
    }

    // ───────────────────────────────────────────────────────────
    // STEP 3: Single final Gemini call - writes the answer
    // ───────────────────────────────────────────────────────────
    const movieContext = finalMovies.map(function(m) {
      return m.title + "|" + m.year + "|" + m.hero + "|" + m.heroine + "|" + m.director + "|" + m.genre + "|" + m.ott_platform + "|" + m.rating + "|" + m.family_watch + "|" + m.type;
    }).join('\n');

    const fallbackNote = usedFallback
      ? "\nNOTE: No exact filter match was found, so this is a general top-rated list. If the user's question seems to need a more specific match than what's below, politely say TFI Cinema Soul's database doesn't have an exact match, while still being helpful with what's shown.\n"
      : "";

    const answerPrompt = "You are Tollywood Chatbot, a Telugu cinema expert for TFI Cinema Soul website.\n\n"
      + "RULES:\n"
      + "- Understand the user's question even with spelling mistakes or Telugu/English mixed language\n"
      + "- Reply in same language as user (Telugu, English or mixed)\n"
      + "- Do NOT write long greetings - start the movie list within 1 short sentence\n"
      + "- Sort by Rating highest first\n"
      + "- Show up to " + resultLimit + " movies\n"
      + "- Format each movie on its own line as: Title (Year) - Rating/10 - OTT Platform\n"
      + "- Only use movies from the DATABASE below - never invent movies\n"
      + fallbackNote + "\n"
      + "DATABASE (title|year|hero|heroine|director|genre|ott|rating|family|type):\n"
      + movieContext + "\n\n"
      + "User question: " + message;

    const answerRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: answerPrompt }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 1024 }
      })
    });

    if (!answerRes.ok) {
      const errText = await answerRes.text();
      return { statusCode: 200, headers, body: JSON.stringify({ reply: 'Gemini API error: ' + answerRes.status + ' - ' + errText }) };
    }

    const answerData = await answerRes.json();
    const candidate = answerData.candidates && answerData.candidates[0];
    const reply = candidate && candidate.content && candidate.content.parts && candidate.content.parts[0]
      ? candidate.content.parts[0].text : 'No response received.';

    return { statusCode: 200, headers, body: JSON.stringify({ reply: reply }) };

  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ reply: 'Error: ' + err.message }) };
  }
};
