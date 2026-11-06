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
  // Hotel search by destination. Booking's robots.txt names no rule for this
  // path (only *nofollow / no_scraping_cache_key query patterns, which this URL
  // never sends). Expedia, Hotels.com and Airbnb disallow their search pages.
  '@booking_search': (query) => `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(query || '')}`,
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
  },
  // Professional and public-interest search. Each URL was checked for a live
  // results page and is not disallowed by the site's robots.txt.
  '@npm_search': (query) => `https://www.npmjs.com/search?q=${encodeURIComponent(query || '')}`,
  '@dockerhub_search': (query) => `https://hub.docker.com/search?q=${encodeURIComponent(query || '')}`,
  '@nhs_search': (query) => `https://www.nhs.uk/search/results?q=${encodeURIComponent(query || '')}`,
  '@legislation_search': (query) => `https://www.legislation.gov.uk/all?title=${encodeURIComponent(query || '')}`,
  '@dailymed_search': (query) => `https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=${encodeURIComponent(query || '')}`,
  '@huggingface_search': (query) => `https://huggingface.co/models?search=${encodeURIComponent(query || '')}`,
  '@jsr_search': (query) => `https://jsr.io/packages?search=${encodeURIComponent(query || '')}`,
  '@bing_news_search': (query) => `https://www.bing.com/news/search?q=${encodeURIComponent(query || '')}`
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
