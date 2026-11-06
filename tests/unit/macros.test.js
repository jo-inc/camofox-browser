import { expandMacro, getSupportedMacros, MACROS } from '../../lib/macros.js';

describe('Macro URL Expansion (unit)', () => {
  
  test('all macros are defined', () => {
    const macros = getSupportedMacros();
    expect(macros).toContain('@google_search');
    expect(macros).toContain('@youtube_search');
    expect(macros).toContain('@amazon_search');
    expect(macros).toContain('@reddit_search');
    expect(macros).toContain('@wikipedia_search');
    expect(macros).toContain('@twitter_search');
    expect(macros).toContain('@yelp_search');
    expect(macros).toContain('@spotify_search');
    expect(macros).toContain('@netflix_search');
    expect(macros).toContain('@linkedin_search');
    expect(macros).toContain('@instagram_search');
    expect(macros).toContain('@tiktok_search');
    expect(macros).toContain('@twitch_search');
    expect(macros).toContain('@reddit_subreddit');
    expect(macros).toContain('@bestbuy_search');
    expect(macros).toContain('@indeed_search');
    expect(macros).toContain('@booking_search');
    expect(macros).toContain('@pubmed_search');
    expect(macros).toContain('@zillow_search');
    expect(macros).toContain('@npm_search');
    expect(macros).toContain('@dockerhub_search');
    expect(macros).toContain('@nhs_search');
    expect(macros).toContain('@legislation_search');
    expect(macros).toContain('@dailymed_search');
    expect(macros).toContain('@huggingface_search');
    expect(macros).toContain('@jsr_search');
    expect(macros).toContain('@bing_news_search');
    expect(macros.length).toBe(27);
  });

  test('AI, package and news macros expand to their search pages', () => {
    expect(expandMacro('@huggingface_search', 'llama')).toBe('https://huggingface.co/models?search=llama');
    expect(expandMacro('@jsr_search', 'zod')).toBe('https://jsr.io/packages?search=zod');
    expect(expandMacro('@bing_news_search', 'climate')).toBe('https://www.bing.com/news/search?q=climate');
  });

  test('professional and public-interest macros expand to their search pages', () => {
    expect(expandMacro('@npm_search', 'react')).toBe('https://www.npmjs.com/search?q=react');
    expect(expandMacro('@dockerhub_search', 'nginx')).toBe('https://hub.docker.com/search?q=nginx');
    expect(expandMacro('@nhs_search', 'diabetes')).toBe('https://www.nhs.uk/search/results?q=diabetes');
    expect(expandMacro('@legislation_search', 'tax')).toBe('https://www.legislation.gov.uk/all?title=tax');
    expect(expandMacro('@dailymed_search', 'ibuprofen')).toBe('https://dailymed.nlm.nih.gov/dailymed/search.cfm?query=ibuprofen');
  });

  test('@bestbuy_search expands correctly', () => {
    expect(expandMacro('@bestbuy_search', 'usb c hub'))
      .toBe('https://www.bestbuy.com/site/searchpage.jsp?st=usb%20c%20hub');
  });

  test('@booking_search expands correctly', () => {
    expect(expandMacro('@booking_search', 'Lisbon'))
      .toBe('https://www.booking.com/searchresults.html?ss=Lisbon');
    expect(expandMacro('@booking_search', 'New York'))
      .toBe('https://www.booking.com/searchresults.html?ss=New%20York');
  });

  test('@indeed_search expands correctly', () => {
    expect(expandMacro('@indeed_search', 'data analyst'))
      .toBe('https://www.indeed.com/jobs?q=data%20analyst');
  });

  test('@pubmed_search expands correctly', () => {
    expect(expandMacro('@pubmed_search', 'sleep apnea'))
      .toBe('https://pubmed.ncbi.nlm.nih.gov/?term=sleep%20apnea');
  });

  test('@zillow_search builds a City,-ST slug', () => {
    expect(expandMacro('@zillow_search', 'Austin, TX'))
      .toBe('https://www.zillow.com/homes/for_sale/Austin,-TX_rb/');
    expect(expandMacro('@zillow_search', 'San Francisco, CA'))
      .toBe('https://www.zillow.com/homes/for_sale/San-Francisco,-CA_rb/');
  });

  test('@zillow_search drops unsafe characters and handles empty query', () => {
    expect(expandMacro('@zillow_search', 'Austin/../admin?x=1'))
      .toBe('https://www.zillow.com/homes/for_sale/Austin..adminx1_rb/');
    expect(expandMacro('@zillow_search', ''))
      .toBe('https://www.zillow.com/homes/for_sale/');
  });

  test('@google_search expands correctly', () => {
    expect(expandMacro('@google_search', 'test query'))
      .toBe('https://www.google.com/search?q=test%20query');
  });

  test('@youtube_search expands correctly', () => {
    expect(expandMacro('@youtube_search', 'funny cats'))
      .toBe('https://www.youtube.com/results?search_query=funny%20cats');
  });

  test('@amazon_search expands correctly', () => {
    expect(expandMacro('@amazon_search', 'laptop stand'))
      .toBe('https://www.amazon.com/s?k=laptop%20stand');
  });

  test('@reddit_search expands correctly', () => {
    expect(expandMacro('@reddit_search', 'programming'))
      .toBe('https://www.reddit.com/search.json?q=programming&limit=25');
  });

  test('@reddit_subreddit expands correctly', () => {
    expect(expandMacro('@reddit_subreddit', 'programming'))
      .toBe('https://www.reddit.com/r/programming.json?limit=25');
  });

  test('@wikipedia_search expands correctly', () => {
    expect(expandMacro('@wikipedia_search', 'JavaScript'))
      .toBe('https://en.wikipedia.org/wiki/Special:Search?search=JavaScript');
  });

  test('@twitter_search expands correctly', () => {
    expect(expandMacro('@twitter_search', 'breaking news'))
      .toBe('https://twitter.com/search?q=breaking%20news');
  });

  test('@yelp_search expands correctly', () => {
    expect(expandMacro('@yelp_search', 'italian restaurant'))
      .toBe('https://www.yelp.com/search?find_desc=italian%20restaurant');
  });

  test('@spotify_search expands correctly', () => {
    expect(expandMacro('@spotify_search', 'jazz music'))
      .toBe('https://open.spotify.com/search/jazz%20music');
  });

  test('@netflix_search expands correctly', () => {
    expect(expandMacro('@netflix_search', 'comedy'))
      .toBe('https://www.netflix.com/search?q=comedy');
  });

  test('@linkedin_search expands correctly', () => {
    expect(expandMacro('@linkedin_search', 'software engineer'))
      .toBe('https://www.linkedin.com/search/results/all/?keywords=software%20engineer');
  });

  test('@instagram_search expands correctly', () => {
    expect(expandMacro('@instagram_search', 'travel'))
      .toBe('https://www.instagram.com/explore/tags/travel');
  });

  test('@tiktok_search expands correctly', () => {
    expect(expandMacro('@tiktok_search', 'dance'))
      .toBe('https://www.tiktok.com/search?q=dance');
  });

  test('@twitch_search expands correctly', () => {
    expect(expandMacro('@twitch_search', 'gaming'))
      .toBe('https://www.twitch.tv/search?term=gaming');
  });

  test('special characters are URL encoded', () => {
    expect(expandMacro('@google_search', 'hello & world'))
      .toBe('https://www.google.com/search?q=hello%20%26%20world');
    
    expect(expandMacro('@google_search', 'test?param=value'))
      .toBe('https://www.google.com/search?q=test%3Fparam%3Dvalue');
    
    expect(expandMacro('@google_search', 'C++ programming'))
      .toBe('https://www.google.com/search?q=C%2B%2B%20programming');
  });

  test('empty query is handled', () => {
    expect(expandMacro('@google_search', ''))
      .toBe('https://www.google.com/search?q=');
    
    expect(expandMacro('@google_search', null))
      .toBe('https://www.google.com/search?q=');
    
    expect(expandMacro('@google_search', undefined))
      .toBe('https://www.google.com/search?q=');
  });

  test('unknown macro returns null', () => {
    expect(expandMacro('@unknown_macro', 'test')).toBeNull();
    expect(expandMacro('@fake_search', 'query')).toBeNull();
    expect(expandMacro('google_search', 'no @ prefix')).toBeNull();
  });

  test('unicode characters are encoded', () => {
    expect(expandMacro('@google_search', '日本語'))
      .toBe('https://www.google.com/search?q=%E6%97%A5%E6%9C%AC%E8%AA%9E');
    
    expect(expandMacro('@google_search', 'café'))
      .toBe('https://www.google.com/search?q=caf%C3%A9');
  });
});
