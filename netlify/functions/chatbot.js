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
    // STEP 1: Ask Gemini to extract structured search filters
    // from the user's question (handles any language/spelling)
    // ───────────────────────────────────────────────────────────
    const extractPrompt = "You are a search filter extractor for a Telugu movie database.\n"
      + "Read the user's question (it may be in Telugu, English, mixed, or have spelling mistakes)\n"
      + "and output ONLY a JSON object with these fields (omit fields that don't apply):\n"
      + "{\n"
      + '  "genre": "string or null - e.g. Thriller, Action, Comedy, Romance, Horror, Drama",\n'
      + '  "hero": "string or null - corrected actor name, e.g. Prabhas, Mahesh Babu, Jr NTR",\n'
      + '  "heroine": "string or null - corrected actress name",\n'
      + '  "director": "string or null - corrected director name",\n'
      + '  "ott_platform": "string or null - one of: Aha, Prime Video, Netflix, Sun NXT, ZEE5, SonyLIV",\n'
      + '  "year": "number or null - specific year if mentioned",\n'
      + '  "type": "string or null - Movie or Series",\n'
      + '  "family_watch": "string or null - Yes or No, only if explicitly asked for family-friendly",\n'
      + '  "limit": "number - how many results user wants, default 8"\n'
      + "}\n"
      + "Fix spelling mistakes silently (prabas->Prabhas, rajamouli->S.S.Rajamouli, mahes->Mahesh Babu, etc).\n"
      + "Output ONLY the raw JSON object, no markdown, no explanation.\n\n"
      + "User question: " + message;

    const extractRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: extractPrompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 300 }
      })
    });

    let filters = {};
    if (extractRes.ok) {
      const extractData = await extractRes.json();
      let extractText = extractData.candidates && extractData.candidates[0] && extractData.candidates[0].content
        ? extractData.candidates[0].content.parts[0].text : '{}';
      // Clean up potential markdown code fences
      extractText = extractText.replace(/```json/g, '').replace(/```/g, '').trim();
      try {
        filters = JSON.parse(extractText);
      } catch (e) {
        filters = {};
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

    const resultLimit = (filters.limit && filters.limit > 0 && filters.limit <= 30) ? filters.limit : 8;
    query = query.limit(Math.max(resultLimit * 3, 30)); // fetch a bit extra in case Gemini wants to pick best ones

    const { data: movies, error } = await query;

    if (error) {
      return { statusCode: 200, headers, body: JSON.stringify({ reply: 'Database error: ' + error.message }) };
    }

    // Fallback: if no filters matched anything specific, do a broader search
    let finalMovies = movies;
    if (!finalMovies || finalMovies.length === 0) {
      const { data: fallbackMovies } = await supabase
        .from('movies')
        .select('title, year, director, hero, heroine, genre, ott_platform, rating, family_watch, type, website_link')
        .order('rating', { ascending: false })
        .limit(30);
      finalMovies = fallbackMovies || [];
    }

    // ───────────────────────────────────────────────────────────
    // STEP 3: Send ONLY the filtered movies to Gemini for final answer
    // ───────────────────────────────────────────────────────────
    const movieContext = finalMovies.map(function(m) {
      return m.title + "|" + m.year + "|" + m.hero + "|" + m.heroine + "|" + m.director + "|" + m.genre + "|" + m.ott_platform + "|" + m.rating + "|" + m.family_watch + "|" + m.type;
    }).join('\n');

    const answerPrompt = "You are Tollywood Chatbot, a Telugu cinema expert for TFI Cinema Soul website.\n\n"
      + "RULES:\n"
      + "- Reply in same language as user (Telugu, English or mixed)\n"
      + "- Do NOT write long greetings - start the movie list within 1 short sentence\n"
      + "- Sort by Rating highest first\n"
      + "- Show up to " + resultLimit + " movies\n"
      + "- Format each movie on its own line as: Title (Year) - Rating/10 - OTT Platform\n"
      + "- Only use movies from the DATABASE below - never invent movies\n"
      + "- If the database below is empty or irrelevant to the question, politely say you couldn't find a match in TFI Cinema Soul's database\n\n"
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

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reply: reply,
        debug_filters: filters,
        debug_moviesFound: finalMovies.length,
        debug_usage: answerData.usageMetadata || {}
      })
    };

  } catch (err) {
    return { statusCode: 200, headers, body: JSON.stringify({ reply: 'Error: ' + err.message }) };
  }
};
