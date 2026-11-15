"""Build the earnings releases documents for the research knowledge base.

Downloads each company's earnings press release (SEC EDGAR, Form 8-K,
Exhibit 99.1), converts it to text and writes, under OUT_DIR:
  reports/<SYMBOL>/<SYMBOL>-earnings-<date>.txt
  metadata/reports/<SYMBOL>/<SYMBOL>-earnings-<date>.txt.metadata.json
The metadata (symbol, company, period, filing date, source URL) lets the
research agent filter the knowledge base by stock symbol.

Usage: python3 -I build_earnings_docs.py OUT_DIR   (then see agents/README.md)
Add a company: append a line to DOCS with the Exhibit 99.1 URL of its latest
earnings 8-K (EDGAR filing index of the company). Each entry is a tuple
(symbol without exchange suffix, company name, filing date YYYY-MM-DD,
period label, Exhibit 99.1 URL).
"""
import json, sys, re, os, urllib.request, html
from html.parser import HTMLParser
UA = {"User-Agent": "datathon2026-equipe14 research prototype (student project) contact@example.com"}
DOCS = [
 ("AAPL", "Apple Inc.", "2026-11-02", "Q4 fiscal 2026", "https://www.sec.gov/Archives/edgar/data/320193/000032019326000024/a8-kex991q4202609262026.htm"),
 ("MSFT", "Microsoft Corporation", "2026-10-28", "Q1 fiscal 2027", "https://www.sec.gov/Archives/edgar/data/789019/000119312526436122/msft-ex99_1.htm"),
 ("SHOP", "Shopify Inc.", "2026-11-03", "Q3 2026", "https://www.sec.gov/Archives/edgar/data/1594805/000159480526000067/exhibit991pressreleaseq320.htm"),
]
class Text(HTMLParser):
    BLOCK = {"p","div","br","tr","li","h1","h2","h3","h4","table","section"}
    def __init__(s): super().__init__(); s.out=[]; s.skip=0
    def handle_starttag(s,t,a):
        if t in ("script","style"): s.skip+=1
        if t in s.BLOCK: s.out.append("\n")
        if t in ("td","th"): s.out.append(" | ")
    def handle_endtag(s,t):
        if t in ("script","style"): s.skip-=1
    def handle_data(s,d):
        if not s.skip: s.out.append(d)
out_dir = sys.argv[1]
for sym, company, date, period, url in DOCS:
    raw = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read().decode("utf-8", "replace")
    p = Text(); p.feed(raw)
    text = html.unescape("".join(p.out)).replace("\xa0", " ")
    text = re.sub(r"[ \t]+", " ", text); text = re.sub(r"( ?\| ?)+", " | ", text)
    text = "\n".join(l.strip(" |") for l in text.splitlines()); text = re.sub(r"\n{3,}", "\n\n", text).strip()
    header = f"{company} ({sym}) - Earnings press release - {period}\nFiled with the SEC on {date} (Form 8-K, Exhibit 99.1)\nSource: {url}\n\n"
    key = f"reports/{sym}/{sym}-earnings-{date}.txt"
    os.makedirs(os.path.dirname(f"{out_dir}/{key}"), exist_ok=True)
    os.makedirs(os.path.dirname(f"{out_dir}/metadata/{key}"), exist_ok=True)
    open(f"{out_dir}/{key}", "w").write(header + text + "\n")
    meta = {"metadataAttributes": {
        "symbol": {"value": {"type": "STRING", "stringValue": sym}},
        "company": {"value": {"type": "STRING", "stringValue": company}},
        "doc_type": {"value": {"type": "STRING", "stringValue": "earnings_release"}},
        "period": {"value": {"type": "STRING", "stringValue": period}},
        "filing_date": {"value": {"type": "NUMBER", "numberValue": int(date.replace("-", ""))}},
        "source_url": {"value": {"type": "STRING", "stringValue": url}},
    }}
    open(f"{out_dir}/metadata/{key}.metadata.json", "w").write(json.dumps(meta, indent=1))
    print(sym, len(text), "chars")
