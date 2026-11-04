const MACROS = {
  '@google_search': (query) => `https://www.google.com/search?q=${encodeURIComponent(query || '')}`,
  '@youtube_search': (query) => `https://www.youtube.com/results?search_query=${encodeURIComponent(query || '')}`,
  '@amazon_search': (query) => `https://www.amazon.com/s?k=${encodeURIComponent(query || '')}`,
  '@reddit_search': (query) => `https://www.reddit.com/search.json?q=${encodeURIComponent(query || '')}&limit=25`,
  '@reddit_subreddit': (query) => `https://www.reddit.com/r/${encodeURIComponent(query || 'all')}.json?limit=25`,
  '@wikipedia_search': (query) => `https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(query || '')}`,
  '@twitter_search': (query) => `https://twitter.com/search?q=${encodeURIComponent(query || '')}`,
  '@yelp_search': (query) => `https://www.yelp.com/search?find_desc=${encodeURIComponent(query || '')}`,
  '@spotify_search': (query) => `https://open.spotify.com/search/${encodeURIComponent(query || '')}`,
  '@netflix_search': (query) => `https://www.netflix.com/search?q=${encodeURIComponent(query || '')}`,
  '@linkedin_search': (query) => `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query || '')}`,
  '@instagram_search': (query) => `https://www.instagram.com/explore/tags/${encodeURIComponent(query || '')}`,
  '@tiktok_search': (query) => `https://www.tiktok.com/search?q=${encodeURIComponent(query || '')}`,
  '@twitch_search': (query) => `https://www.twitch.tv/search?term=${encodeURIComponent(query || '')}`,
  '@bestbuy_search': (query) => `https://www.bestbuy.com/site/searchpage.jsp?st=${encodeURIComponent(query || '')}`,
  '@indeed_search': (query) => `https://www.indeed.com/jobs?q=${encodeURIComponent(query || '')}`,
  '@pubmed_search': (query) => `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(query || '')}`,
  // Zillow's path uses a "City,-ST" slug (e.g. Austin,-TX_rb). Spaces become
  // hyphens; characters outside letters, digits, comma, hyphen and dot are dropped.
  '@zillow_search': (query) => {
    const slug = String(query || '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^A-Za-z0-9,.-]/g, '');
    return slug
      ? `https://www.zillow.com/homes/for_sale/${slug}_rb/`
      : 'https://www.zillow.com/homes/for_sale/';
  }
};

function expandMacro(macro, query) {
  const macroFn = MACROS[macro];
  return macroFn ? macroFn(query) : null;
}

function getSupportedMacros() {
  return Object.keys(MACROS);
}

export {
  expandMacro,
  getSupportedMacros,
  MACROS
};
