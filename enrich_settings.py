#!/usr/bin/env python3
import argparse
import json
import os
import re
import sys
from collections import defaultdict
from typing import Dict, List, Tuple, Set


def load_json(path: str) -> Dict:
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_json(path: str, obj: Dict) -> None:
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def normalize_name(name: str) -> str:
    return re.sub(r"[^a-z0-9_]+", "_", name.lower())


def name_tokens(name: str) -> List[str]:
    # split on underscores and drop very short tokens
    return [t for t in normalize_name(name).split('_') if t and len(t) >= 2]


def jaccard(a: Set[str], b: Set[str]) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    if inter == 0:
        return 0.0
    return inter / float(len(a | b))


def compute_token_related(all_nodes: List[Dict], by_name: Dict[str, Dict], max_per_item: int = 8) -> Dict[str, List[Tuple[str, float, List[str]]]]:
    # returns mapping name -> list of (other_name, score, reasons)
    rel: Dict[str, List[Tuple[str, float, List[str]]]] = {}
    tok_map: Dict[str, Set[str]] = {}
    for n in all_nodes:
        tok_map[n['name']] = set(name_tokens(n['name']))
    names = [n['name'] for n in all_nodes]
    for i, a in enumerate(names):
        A = tok_map.get(a, set())
        scored: List[Tuple[str, float, List[str]]] = []
        # Heuristics for families
        for j, b in enumerate(names):
            if a == b:
                continue
            B = tok_map.get(b, set())
            score = 0.0
            reasons: List[str] = []
            sim = jaccard(A, B)
            if sim >= 0.25:
                score += sim * 4.0
                reasons.append('token_overlap')
            # min/max, initial/max, *_bytes vs *_rows, *_threads vs *_pool*
            an = normalize_name(a)
            bn = normalize_name(b)
            if an.startswith('min_') and bn.startswith('max_') and an[4:] == bn[4:]:
                score += 2.0; reasons.append('min_max_pair')
            if an.startswith('initial_') and bn.startswith('max_') and an[8:] == bn[4:]:
                score += 1.5; reasons.append('initial_max_pair')
            if an.endswith('_bytes') and bn.endswith('_rows') and an[:-6] == bn[:-5]:
                score += 1.5; reasons.append('bytes_rows_pair')
            if an.endswith('_rows') and bn.endswith('_bytes') and an[:-5] == bn[:-6]:
                score += 1.5; reasons.append('bytes_rows_pair')
            if (('_threads' in an and '_pool' in bn) or ('_threads' in bn and '_pool' in an)):
                score += 0.8; reasons.append('threads_pools')
            if score > 0:
                # Slight boost if same scope/topic
                a_topic = (by_name[a].get('category') or '')
                b_topic = (by_name[b].get('category') or '')
                if a_topic and b_topic and a_topic == b_topic:
                    score += 0.25
                scored.append((b, score, reasons))
        scored.sort(key=lambda x: x[1], reverse=True)
        rel[a] = scored[:max_per_item]
    return rel


def compute_cochange_related(all_nodes: List[Dict], max_per_item: int = 4) -> Dict[str, List[Tuple[str, float, List[str]]]]:
    # Build version_minor -> set(names) from history fields
    by_version: Dict[str, Set[str]] = defaultdict(set)
    for n in all_nodes:
        for h in n.get('history', []) or []:
            vm = h.get('version_minor')
            if vm:
                by_version[vm].add(n['name'])
    # For each pair co-mentioned in same version, add edge
    rel: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for vm, names in by_version.items():
        for a in names:
            for b in names:
                if a == b:
                    continue
                rel[a][b] += 1.0
    out: Dict[str, List[Tuple[str, float, List[str]]]] = {}
    for a, mp in rel.items():
        lst = [(b, score, ['co_changed']) for b, score in mp.items()]
        lst.sort(key=lambda x: x[1], reverse=True)
        out[a] = lst[:max_per_item]
    return out


def parse_docs_mentions(docs_root: str, scopes: Dict[str, List[Dict]]) -> Tuple[Dict[str, List[Dict]], Dict[str, List[Tuple[str, float, List[str]]]]]:
    """Scan key docs markdown files for co-mentions and simple snippets.
    Returns (mentions_map, co_mentions_map)
    mentions_map: name -> list of {url, excerpt}
    co_mentions_map: name -> list of (other_name, score, reasons)
    """
    files = [
        ('session', os.path.join(docs_root, 'docs/en/operations/settings/settings.md')),
        ('mergetree', os.path.join(docs_root, 'docs/en/operations/settings/merge-tree-settings.md')),
        ('format', os.path.join(docs_root, 'docs/en/operations/settings/formats.md')),
    ]
    # Index of names
    names: Set[str] = set()
    for arr in scopes.values():
        for s in arr:
            names.add(s['name'])
    # Pre-compile regex for backticked names or word-boundary names
    name_re = re.compile(r"`([a-z0-9_]+)`|\b([a-z0-9_]{3,})\b", re.IGNORECASE)

    mentions: Dict[str, List[Dict]] = defaultdict(list)
    co: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))

    def add_mention(nm: str, url: str, para: str):
        if not nm:
            return
        if nm not in names:
            return
        excerpt = para.strip()
        if len(excerpt) > 220:
            excerpt = excerpt[:220] + '…'
        item = { 'url': url, 'excerpt': excerpt }
        lst = mentions[nm]
        if all(x.get('url') != url or x.get('excerpt') != excerpt for x in lst):
            lst.append(item)

    for scope, fpath in files:
        if not os.path.exists(fpath):
            continue
        try:
            text = open(fpath, 'r', encoding='utf-8', errors='ignore').read()
        except Exception:
            continue
        # Split into paragraphs by blank lines
        paras = re.split(r"\n\s*\n", text)
        base_url = 'https://clickhouse.com/docs/operations/settings/' + (
            'settings' if scope=='session' else ('merge-tree-settings' if scope=='mergetree' else 'formats')
        )
        for para in paras:
            # Collect names mentioned in this paragraph
            found: Set[str] = set()
            for m in name_re.finditer(para.lower()):
                nm = (m.group(1) or m.group(2) or '').lower()
                if nm in names:
                    found.add(nm)
            if not found:
                continue
            # Record mentions and co-mentions
            for nm in found:
                add_mention(nm, base_url + '#' + nm, para)
            if len(found) >= 2:
                for a in found:
                    for b in found:
                        if a == b:
                            continue
                        co[a][b] += 0.5

    co_out: Dict[str, List[Tuple[str, float, List[str]]]] = {}
    for a, mp in co.items():
        lst = [(b, score, ['docs_comention']) for b, score in mp.items()]
        lst.sort(key=lambda x: x[1], reverse=True)
        co_out[a] = lst[:6]
    return mentions, co_out


def merge_related(*rels: Dict[str, List[Tuple[str, float, List[str]]]], limit: int = 8) -> Dict[str, List[Dict]]:
    combined: Dict[str, Dict[str, Tuple[float, List[str]]]] = defaultdict(dict)
    for r in rels:
        for a, lst in r.items():
            for b, score, reasons in lst:
                prev = combined[a].get(b)
                if prev:
                    combined[a][b] = (prev[0] + score, list(set(prev[1] + reasons)))
                else:
                    combined[a][b] = (score, list(set(reasons)))
    out: Dict[str, List[Dict]] = {}
    for a, mp in combined.items():
        items = [ {'name': b, 'score': round(score, 2), 'reasons': sorted(reasons)} for b, (score, reasons) in mp.items() ]
        items.sort(key=lambda x: x['score'], reverse=True)
        out[a] = items[:limit]
    return out


def fetch_url(url: str, timeout: int = 15) -> str:
    import urllib.request
    req = urllib.request.Request(url, headers={'User-Agent': 'SettingsEnrich/1.0'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    try:
        return data.decode('utf-8', errors='ignore')
    except Exception:
        return data.decode('latin-1', errors='ignore')


def strip_html(html: str) -> Tuple[str, str]:
    """Return (title, text) naive HTML to text extraction.
    Removes scripts/styles, pulls <title>, collapses whitespace.
    """
    # remove scripts/styles
    html = re.sub(r"<script[\s\S]*?</script>", " ", html, flags=re.IGNORECASE)
    html = re.sub(r"<style[\s\S]*?</style>", " ", html, flags=re.IGNORECASE)
    # title
    m = re.search(r"<title>(.*?)</title>", html, flags=re.IGNORECASE|re.DOTALL)
    title = re.sub(r"\s+", " ", m.group(1)).strip() if m else ''
    # tags to newlines
    text = re.sub(r"<\s*br\s*/?\s*>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"</p>|</div>|</h[1-6]>|</li>", "\n\n", text, flags=re.IGNORECASE)
    # strip tags
    text = re.sub(r"<[^>]+>", " ", text)
    # collapse whitespace
    text = re.sub(r"\s+", " ", text)
    # rebuild paragraphs roughly
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return title, text


def parse_online_mentions(urls: List[str], names: Set[str]) -> Tuple[Dict[str, List[Dict]], Dict[str, List[Tuple[str, float, List[str]]]]]:
    mentions: Dict[str, List[Dict]] = defaultdict(list)
    co: Dict[str, Dict[str, float]] = defaultdict(lambda: defaultdict(float))
    for url in urls:
        if not url.startswith('http'):  # skip bad lines
            continue
        # Restrict to clickhouse.com/blog or release notes on clickhouse.com
        if not (url.startswith('https://clickhouse.com/blog/') or url.startswith('https://clickhouse.com/blog') or url.startswith('https://clickhouse.com/')):
            continue
        try:
            html = fetch_url(url)
        except Exception as e:
            print(f"WARN: fetch failed for {url}: {e}", file=sys.stderr)
            continue
        title, text = strip_html(html)
        # split into pseudo paragraphs by periods or newlines (rough)
        paras = re.split(r"\n\n|(?<=\.)\s{2,}", text)
        name_re = re.compile(r"`([a-z0-9_]+)`|\b([a-z0-9_]{3,})\b", re.IGNORECASE)
        def add_mention(nm: str, excerpt: str):
            item = { 'url': url, 'title': title, 'excerpt': excerpt.strip()[:220] + ('…' if len(excerpt.strip())>220 else '') }
            lst = mentions[nm]
            if all(x.get('url') != url or x.get('excerpt') != item['excerpt'] for x in lst):
                lst.append(item)
        for para in paras:
            found: Set[str] = set()
            for m in name_re.finditer(para.lower()):
                nm = (m.group(1) or m.group(2) or '').lower()
                if nm in names:
                    found.add(nm)
            if not found:
                continue
            for nm in found:
                add_mention(nm, para)
            if len(found) >= 2:
                for a in found:
                    for b in found:
                        if a == b: continue
                        co[a][b] += 0.5
    co_out: Dict[str, List[Tuple[str, float, List[str]]]] = {}
    for a, mp in co.items():
        lst = [(b, score, ['blog_comention']) for b, score in mp.items()]
        lst.sort(key=lambda x: x[1], reverse=True)
        co_out[a] = lst[:6]
    return mentions, co_out


def main() -> None:
    ap = argparse.ArgumentParser(description='Enrich settings.json with related edges and docs mentions')
    ap.add_argument('--in', dest='in_path', default='settings.json', help='Input settings.json')
    ap.add_argument('--out', dest='out_path', default='settings.json', help='Output settings.json (in-place by default)')
    ap.add_argument('--docs', dest='docs_root', default='clickhouse-docs', help='Path to clickhouse-docs repo (optional)')
    ap.add_argument('--blog-urls', dest='blog_urls', help='Path to a file with blog/release note URLs (one per line; clickhouse.com only)')
    args = ap.parse_args()

    data = load_json(args.in_path)

    # Flatten all settings into a single list and name->obj map
    buckets = {
        'session': data.get('settings', []) or [],
        'mergetree': data.get('merge_tree_settings', []) or [],
        'format': data.get('format_settings', []) or [],
    }
    all_nodes: List[Dict] = []
    by_name: Dict[str, Dict] = {}
    for scope, arr in buckets.items():
        for s in arr:
            all_nodes.append(s)
            by_name[s['name']] = s

    # Compute relations from tokens/families and co-change history
    rel_tokens = compute_token_related(all_nodes, by_name)
    rel_cochange = compute_cochange_related(all_nodes)

    # Docs mentions and simple co-mentions
    mentions: Dict[str, List[Dict]] = {}
    rel_docs: Dict[str, List[Tuple[str, float, List[str]]]] = {}
    if args.docs_root and os.path.isdir(args.docs_root):
        try:
            mentions, rel_docs = parse_docs_mentions(args.docs_root, buckets)
        except Exception as e:
            print(f"WARN: docs parsing failed: {e}", file=sys.stderr)

    # Blog / online mentions (optional)
    rel_blogs: Dict[str, List[Tuple[str, float, List[str]]]] = {}
    blog_mentions: Dict[str, List[Dict]] = {}
    blog_urls_total = 0
    if args.blog_urls and os.path.exists(args.blog_urls):
        try:
            urls = [ln.strip() for ln in open(args.blog_urls, 'r', encoding='utf-8') if ln.strip() and not ln.strip().startswith('#')]
            blog_urls_total = len(urls)
            names_set = set(by_name.keys())
            blog_mentions, rel_blogs = parse_online_mentions(urls, names_set)
        except Exception as e:
            print(f"WARN: blog parsing failed: {e}", file=sys.stderr)

    # Merge relations with weights
    merged = merge_related(rel_tokens, rel_cochange, rel_docs, rel_blogs, limit=8)

    # Attach to each node
    for s in all_nodes:
        name = s['name']
        if name in merged:
            s['related'] = merged[name]
        if mentions.get(name):
            s.setdefault('mentions', {})['docs'] = mentions[name]
        if blog_mentions.get(name):
            s.setdefault('mentions', {})['blogs'] = blog_mentions[name]

    # Mark metadata
    data['enriched'] = True
    save_json(args.out_path, data)
    # Verbose summary
    def edge_count(m: Dict[str, List[Tuple[str, float, List[str]]]]) -> int:
        return sum(len(v) for v in m.values())
    token_edges = edge_count(rel_tokens)
    cochange_edges = edge_count(rel_cochange)
    docs_edges = edge_count(rel_docs)
    blog_edges = edge_count(rel_blogs)
    docs_mentions_count = sum(len(v) for v in mentions.values())
    blog_mentions_count = sum(len(v) for v in blog_mentions.values())
    related_settings = sum(1 for s in all_nodes if s.get('related'))
    print(
        "\n".join([
            f"Enriched {args.out_path}: {len(all_nodes)} settings",
            f" - Related settings populated for: {related_settings}",
            f" - Edge signals: tokens={token_edges}, co_changed={cochange_edges}, docs_comention={docs_edges}, blog_comention={blog_edges}",
            f" - Mentions: docs={docs_mentions_count}, blogs={blog_mentions_count}",
            (f" - Blog URLS processed: {blog_urls_total}" if blog_urls_total else " - Blog URLS processed: 0"),
        ])
    )


if __name__ == '__main__':
    main()
