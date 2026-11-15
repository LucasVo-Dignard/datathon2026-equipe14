'use strict';
// RSS feeds of known media, read by jobs/news-refresh.js.
//
// Terms: these feeds are offered for personal use and for aggregators that
// show the headline and a short excerpt with a link to the original article
// and the source name. That is all we keep and show: no full text, every item
// links back to the publisher. See the terms linked below before adding a feed
// or showing more.

const FEEDS = [
  {
    id: 'cbc-business',
    name: 'CBC Business',
    url: 'https://www.cbc.ca/webfeed/rss/rss-business',
    language: 'en',
    terms: 'https://www.cbc.ca/rss/',
  },
  {
    id: 'radio-canada-economie',
    name: 'Radio-Canada Économie',
    url: 'https://ici.radio-canada.ca/rss/5717',
    language: 'fr',
    terms: 'https://ici.radio-canada.ca/rss',
  },
  {
    id: 'globe-business',
    name: 'The Globe and Mail',
    url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/business/',
    language: 'en',
    terms: 'https://www.theglobeandmail.com/about/rss/',
  },
  {
    id: 'marketwatch',
    name: 'MarketWatch',
    url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
    language: 'en',
    terms: 'https://www.marketwatch.com/site/rss',
  },
];

module.exports = { FEEDS };
