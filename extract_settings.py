#!/usr/bin/env python3
import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


@dataclass
class SettingEntry:
    name: str
    type: str
    default: str
    description: str
    flags: str
    alias: Optional[str] = None


def run(cmd: List[str], cwd: Optional[str] = None) -> str:
    p = subprocess.run(cmd, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{p.stderr}")
    return p.stdout


def git_show(repo: str, rev: str, path: str) -> Optional[str]:
    try:
        return run(["git", "show", f"{rev}:{path}"], cwd=repo)
    except Exception:
        return None


def git_commit_date(repo: str, rev: str) -> int:
    out = run(["git", "show", "-s", "--format=%ct", rev], cwd=repo).strip()
    return int(out)


def git_list_tags(repo: str) -> List[str]:
    out = run(["git", "tag", "--list"], cwd=repo)
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def git_show_text(repo: str, rev: str, path: str) -> Optional[str]:
    try:
        return run(["git", "show", f"{rev}:{path}"], cwd=repo)
    except Exception:
        return None


def parse_categories_file(path: Optional[str]) -> Dict[str, List[str]]:
    if not path:
        return {}
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return {}
    # Very small YAML subset parser: top-level mapping of key -> list of strings
    categories: Dict[str, List[str]] = {}
    current_key: Optional[str] = None
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            line = raw.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            if not line.startswith(" ") and ":" in line:
                key = line.split(":", 1)[0].strip()
                current_key = key
                categories[current_key] = []
            elif line.startswith("  - ") and current_key is not None:
                item = line[4:].strip()
                # Strip quotes if present
                if (item.startswith("'") and item.endswith("'")) or (item.startswith('"') and item.endswith('"')):
                    item = item[1:-1]
                categories[current_key].append(item)
            else:
                # Ignore other constructs
                pass
    return categories


def parse_changelog_minors(path: str) -> List[Tuple[str, str]]:
    """Parse CHANGELOG.md for monthly releases.

    Returns list of tuples: (minor, channel) where minor like 'v25.8' and channel is 'lts' or 'stable'.
    The file is scanned top-to-bottom; order is preserved.
    """
    if not os.path.exists(path):
        return []
    text = open(path, "r", encoding="utf-8", errors="ignore").read()
    minors: List[Tuple[str, str]] = []
    # Matches e.g. "ClickHouse release v25.8 LTS" or "ClickHouse release v25.7,"
    for m in re.finditer(r"ClickHouse release\s+v(\d+\.\d+)(?:\s+LTS)?", text):
        minor = f"v{m.group(1)}"
        # Determine if LTS by searching up to the end of the line
        line_start = text.rfind("\n", 0, m.start()) + 1
        line_end = text.find("\n", m.end())
        if line_end == -1:
            line_end = len(text)
        line = text[line_start:line_end]
        channel = 'lts' if re.search(r"\bLTS\b", line) else 'stable'
        minors.append((minor, channel))
    return minors


def latest_tag_for_minor(tags: List[str], minor: str, channel: str) -> Optional[str]:
    """Pick the latest tag for a minor version and channel (stable/lts)."""
    # Tag format: vMAJ.MIN.P1.P2-suffix
    pat = re.compile(rf"^{re.escape(minor)}\.(\d+)\.(\d+)-({channel})$")
    candidates: List[Tuple[int, int, str]] = []
    for t in tags:
        m = pat.match(t)
        if not m:
            continue
        a = int(m.group(1))
        b = int(m.group(2))
        candidates.append((a, b, t))
    if not candidates:
        return None
    candidates.sort()  # numeric ascending by (a,b)
    return candidates[-1][2]


def versions_from_changelog(repo: str, changelog_path: str, limit_minors: Optional[int], channel_filter: str) -> List[str]:
    minors = parse_changelog_minors(changelog_path)
    if not minors:
        return []
    if channel_filter in ("stable", "lts"):
        minors = [x for x in minors if x[1] == channel_filter]
    # Keep most recent minors first as in changelog; apply limit
    if limit_minors is not None:
        minors = minors[:limit_minors]
    tags = git_list_tags(repo)
    result: List[str] = []
    for minor, channel in minors:
        tag = latest_tag_for_minor(tags, minor, channel)
        if tag:
            result.append(tag)
    return result


def find_macro_block(source: str, macro_name: str) -> Optional[str]:
    # Prefer the variant that ends with a continuation backslash
    pattern = re.compile(rf"^#define\s+{re.escape(macro_name)}\s*\(.*?\)\s*\\\s*$", re.MULTILINE)
    m = pattern.search(source)
    if not m:
        return None
    start = m.end()
    # Stop at OBSOLETE_SETTINGS macro start if present, otherwise next #define
    end_marker = re.search(r"^#define\s+OBSOLETE_SETTINGS\b", source[start:], re.MULTILINE)
    if end_marker:
        return source[start:start + end_marker.start()]
    rest = source[start:]
    next_def = re.search(r"^#define\s+\w+", rest, re.MULTILINE)
    return rest[: next_def.start()] if next_def else rest


def read_balanced_call(text: str, start_idx: int) -> Tuple[str, int]:
    # Given text and index pointing at the '(' of a call, return the full call content until matching ')'
    i = start_idx
    assert text[i] == "("
    depth = 0
    buf = []
    i0 = i
    while i < len(text):
        ch = text[i]
        # Handle raw string before anything else
        if text.startswith('R"', i):
            j = i + 2
            delim = ''
            if j < len(text) and text[j] != '(':
                while j < len(text) and text[j] != '(':
                    delim += text[j]
                    j += 1
            if j < len(text) and text[j] == '(':
                end_pat = ")" + delim + '"'
                j += 1
                k = text.find(end_pat, j)
                if k == -1:
                    raise ValueError("Unterminated raw string literal")
                buf.append(text[i:k+len(end_pat)])
                i = k + len(end_pat)
                continue
        # Handle regular C string before appending generic char
        if ch == '"':
            start_q = i
            i += 1
            while i < len(text):
                if text[i] == '\\':
                    i += 2
                    continue
                if text[i] == '"':
                    i += 1
                    break
                i += 1
            buf.append(text[start_q:i])
            continue

        buf.append(ch)
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0:
                return ("".join(buf), i + 1)
        i += 1
    raise ValueError(f"Unbalanced parentheses starting at {i0}")


def split_top_level_args(call: str) -> List[str]:
    # call includes surrounding parentheses
    assert call.startswith('(') and call.endswith(')')
    s = call[1:-1]
    args: List[str] = []
    depth = 0
    cur = []
    i = 0
    while i < len(s):
        ch = s[i]
        if ch == '(':
            depth += 1
            cur.append(ch)
        elif ch == ')':
            depth -= 1
            cur.append(ch)
        elif ch == ',':
            if depth == 0:
                args.append("".join(cur).strip())
                cur = []
            else:
                cur.append(ch)
        elif ch == '"':
            # C string
            start = i
            i += 1
            while i < len(s):
                if s[i] == '\\':
                    i += 2
                    continue
                if s[i] == '"':
                    i += 1
                    break
                i += 1
            cur.append(s[start:i])
            continue
        elif s.startswith('R"', i):
            # Raw string literal
            j = i + 2
            delim = ''
            if j < len(s) and s[j] != '(':
                while j < len(s) and s[j] != '(':
                    delim += s[j]
                    j += 1
            if j < len(s) and s[j] == '(':
                end_pat = ")" + delim + '"'
                j += 1
                k = s.find(end_pat, j)
                if k == -1:
                    raise ValueError("Unterminated raw string in args")
                cur.append(s[i:k+len(end_pat)])
                i = k + len(end_pat)
                continue
        else:
            cur.append(ch)
        i += 1
    if cur:
        args.append("".join(cur).strip())
    return args


def parse_declarations(block: str) -> List[SettingEntry]:
    entries: List[SettingEntry] = []
    i = 0
    while i < len(block):
        # Skip whitespace
        if block.startswith("DECLARE_WITH_ALIAS", i):
            j = i + len("DECLARE_WITH_ALIAS")
            assert block[j] == '(' or block[j].isspace()
            while block[j].isspace():
                j += 1
            if block[j] != '(':
                i += 1
                continue
            call, new_i = read_balanced_call(block, j)
            args = split_top_level_args(call)
            # EXPECT: type, name, default, description, flags, alias (alias is last)
            if len(args) >= 6:
                entries.append(SettingEntry(
                    name=args[1],
                    type=args[0],
                    default=args[2],
                    description=args[-3],
                    flags=args[-2],
                    alias=args[-1],
                ))
            i = new_i
            continue
        if block.startswith("DECLARE", i):
            j = i + len("DECLARE")
            assert block[j] == '(' or block[j].isspace()
            while block[j].isspace():
                j += 1
            if block[j] != '(':
                i += 1
                continue
            call, new_i = read_balanced_call(block, j)
            args = split_top_level_args(call)
            # EXPECT: type, name, default, description, flags
            if len(args) >= 5:
                entries.append(SettingEntry(
                    name=args[1],
                    type=args[0],
                    default=args[2],
                    description=args[3],
                    flags=args[4],
                ))
            i = new_i
            continue
        i += 1
    return entries


def unquote_cpp_string(s: str) -> str:
    s = s.strip()
    if s.startswith('R"'):
        # Raw string: R"( ... )" possibly with delimiter
        # Find first '(' and last )" pair
        i = s.find('(')
        j = s.rfind(')"')
        if i != -1 and j != -1 and j > i:
            return s[i+1:j]
        return s
    if s.startswith('"') and s.endswith('"'):
        return bytes(s[1:-1], 'utf-8').decode('unicode_escape')
    return s


def normalize_default_value(s: str) -> str:
    return s.strip()


def categorize(name: str, description: str, categories: Dict[str, List[str]]) -> str:
    text = f"{name} {description}".lower()
    for cat, patterns in categories.items():
        for pat in patterns:
            try:
                if re.search(pat, text, re.IGNORECASE):
                    return cat
            except re.error:
                # Fallback to substring
                if pat.lower() in text:
                    return cat
    return "Uncategorized"


def is_cloud_only(description: str) -> bool:
    if not description:
        return False
    text = description.lower()
    patterns = [
        r"\bonly has an effect in clickhouse cloud\b",
        r"\bonly in clickhouse cloud\b",
        r"\bonly available in clickhouse cloud\b",
        r"\bclickhouse cloud only\b",
    ]
    return any(re.search(p, text) for p in patterns)


def parse_flags(flags: str) -> Tuple[str, bool]:
    """Parse flags from Settings.cpp into (tier, important).

    - tier: 'production' (default), 'beta', 'experimental', or 'obsolete' if detected.
    - important: boolean if IMPORTANT is set.
    Flags can be like: 0, BETA, EXPERIMENTAL, IMPORTANT, or combinations.
    """
    if flags is None:
        return ("production", False)
    f = flags.strip()
    if not f or f == '0':
        return ("production", False)
    # Normalize separators: some macros could use commas or bitwise ops, we just search tokens
    tokens = re.split(r"[^A-Za-z_]+", f)
    tokens = [t for t in tokens if t]
    t_lower = [t.lower() for t in tokens]
    important = any(t.lower() == 'important' for t in tokens)
    tier = 'production'
    if 'experimental' in t_lower:
        tier = 'experimental'
    elif 'beta' in t_lower:
        tier = 'beta'
    elif 'obsolete' in t_lower:
        tier = 'obsolete'
    return (tier, important)


def split_top_level_commas(s: str) -> List[str]:
    parts: List[str] = []
    cur: List[str] = []
    depth_round = depth_brace = depth_square = 0
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            cur.append(ch)
            if esc:
                esc = False
            elif ch == '\\':
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
            cur.append(ch)
            continue
        if ch == '(':
            depth_round += 1
        elif ch == ')':
            depth_round = max(0, depth_round - 1)
        elif ch == '{':
            depth_brace += 1
        elif ch == '}':
            depth_brace = max(0, depth_brace - 1)
        elif ch == '[':
            depth_square += 1
        elif ch == ']':
            depth_square = max(0, depth_square - 1)
        if ch == ',' and depth_round == 0 and depth_brace == 0 and depth_square == 0:
            parts.append(''.join(cur).strip())
            cur = []
        else:
            cur.append(ch)
    if cur:
        parts.append(''.join(cur).strip())
    return parts


def unquote(s: str) -> str:
    s = s.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        return s[1:-1]
    return s


def parse_settings_changes_history(source: str) -> Dict[str, List[Dict[str, str]]]:
    """Parse SettingsChangesHistory.cpp text into mapping name -> list of changes.

    Each change item: {version_minor, new_default, comment}
    """
    if not source:
        return {}
    changes: Dict[str, List[Dict[str, str]]] = {}
    # Extract blocks: addSettingsChanges(settings_changes_history, "25.8", { ... });
    for m in re.finditer(r"addSettingsChanges\s*\([^,]+,\s*\"([^\"]+)\"\s*,\s*\{(.*?)\}\s*\)\s*;", source, re.DOTALL):
        version_minor = m.group(1)
        body = m.group(2)
        # Iterate over top-level {...} items
        i = 0
        while i < len(body):
            if body[i] == '{':
                depth = 1
                j = i + 1
                in_str = False
                esc = False
                while j < len(body) and depth > 0:
                    ch = body[j]
                    if in_str:
                        if esc:
                            esc = False
                        elif ch == '\\':
                            esc = True
                        elif ch == '"':
                            in_str = False
                    else:
                        if ch == '"':
                            in_str = True
                        elif ch == '{':
                            depth += 1
                        elif ch == '}':
                            depth -= 1
                    j += 1
                inner = body[i+1:j-1]
                parts = split_top_level_commas(inner)
                if len(parts) >= 4:
                    name = unquote(parts[0])
                    new_default = parts[2].strip()
                    comment = unquote(parts[3])
                    changes.setdefault(name, []).append({
                        'version_minor': version_minor,
                        'new_default': new_default,
                        'comment': comment,
                    })
                i = j
            else:
                i += 1
    # Sort each list by version string descending (lexicographic on major.minor works adequately if format is NN.N)
    for lst in changes.values():
        lst.sort(key=lambda x: x['version_minor'], reverse=True)
    return changes


def extract_from_version(repo: str, rev: str, categories: Dict[str, List[str]]) -> Dict[str, Dict]:
    # Returns mapping name -> info for the given rev
    settings_cpp = git_show(repo, rev, "src/Core/Settings.cpp")
    if not settings_cpp:
        return {}
    block = find_macro_block(settings_cpp, "COMMON_SETTINGS")
    if not block:
        return {}
    decls = parse_declarations(block)
    result: Dict[str, Dict] = {}
    for d in decls:
        desc = unquote_cpp_string(d.description)
        cat = categorize(d.name, desc, categories)
        tier, important = parse_flags(d.flags)
        result[d.name] = {
            "name": d.name,
            "type": d.type,
            "default": normalize_default_value(d.default),
            "description": desc,
            "flags": d.flags.strip(),
            "alias": d.alias.strip() if d.alias else None,
            "category": cat,
            "cloud_only": is_cloud_only(desc),
            "tier": tier,
            "important": important,
            "docs_url": f"https://clickhouse.com/docs/operations/settings/settings#{d.name}",
        }
    return result


def extract_mergetree_from_version(repo: str, rev: str, categories: Dict[str, List[str]]) -> Dict[str, Dict]:
    mt_cpp = git_show(repo, rev, "src/Storages/MergeTree/MergeTreeSettings.cpp")
    if not mt_cpp:
        return {}
    block = find_macro_block(mt_cpp, "MERGE_TREE_SETTINGS")
    if not block:
        return {}
    decls = parse_declarations(block)
    result: Dict[str, Dict] = {}
    for d in decls:
        desc = unquote_cpp_string(d.description)
        cat = categorize(d.name, desc, categories)
        tier, important = parse_flags(d.flags)
        result[d.name] = {
            "name": d.name,
            "type": d.type,
            "default": normalize_default_value(d.default),
            "description": desc,
            "flags": d.flags.strip(),
            "alias": d.alias.strip() if d.alias else None,
            "category": cat,
            "cloud_only": is_cloud_only(desc),
            "tier": tier,
            "important": important,
            "docs_url": f"https://clickhouse.com/docs/operations/settings/merge-tree-settings#{d.name}",
        }
    return result


def extract_format_from_version(repo: str, rev: str, categories: Dict[str, List[str]]) -> Dict[str, Dict]:
    fmt_h = git_show(repo, rev, "src/Core/FormatFactorySettings.h")
    if not fmt_h:
        return {}
    block = find_macro_block(fmt_h, "FORMAT_FACTORY_SETTINGS")
    if not block:
        return {}
    decls = parse_declarations(block)
    result: Dict[str, Dict] = {}
    for d in decls:
        desc = unquote_cpp_string(d.description)
        cat = categorize(d.name, desc, categories)
        tier, important = parse_flags(d.flags)
        result[d.name] = {
            "name": d.name,
            "type": d.type,
            "default": normalize_default_value(d.default),
            "description": desc,
            "flags": d.flags.strip(),
            "alias": d.alias.strip() if d.alias else None,
            "category": cat,
            "cloud_only": is_cloud_only(desc),
            "tier": tier,
            "important": important,
            "docs_url": f"https://clickhouse.com/docs/operations/settings/formats#{d.name}",
        }
    return result


def main() -> None:
    ap = argparse.ArgumentParser(description="Extract ClickHouse settings across versions")
    ap.add_argument("--repo", required=True, help="Path to ClickHouse repo")
    ap.add_argument("--versions", nargs="*", help="List of commit-ish (tags/SHAs)")
    ap.add_argument("--versions-file", help="File with one commit-ish per line")
    ap.add_argument("--from-changelog", dest="from_changelog", help="Path to CHANGELOG.md to derive versions")
    ap.add_argument("--minors", type=int, default=None, help="Limit number of minors from changelog (most recent)")
    ap.add_argument("--channel", choices=["stable", "lts", "both"], default="both", help="Filter channel when deriving from changelog")
    ap.add_argument("--categories", help="Path to categories.yaml (optional)")
    ap.add_argument("--out", default="settings.json", help="Output JSON path")
    args = ap.parse_args()

    if not os.path.isdir(args.repo):
        print(f"Repo not found: {args.repo}", file=sys.stderr)
        sys.exit(1)

    versions: List[str] = []
    # Populate versions from changelog if requested
    if args.from_changelog:
        channel_filter = args.channel if args.channel != "both" else "both"
        versions_from_cl = versions_from_changelog(args.repo, args.from_changelog, args.minors, channel_filter)
        versions.extend(versions_from_cl)
    if args.versions_file:
        with open(args.versions_file, "r", encoding="utf-8") as f:
            versions.extend([ln.strip() for ln in f if ln.strip()])
    if args.versions:
        versions.extend(args.versions)

    if not versions:
        # Default to current HEAD
        versions = ["HEAD"]

    # Sort by commit date ascending
    versions_with_dates = []
    for v in versions:
        try:
            ts = git_commit_date(args.repo, v)
        except Exception:
            ts = 0
        versions_with_dates.append((v, ts))
    versions_sorted = [v for v, _ in sorted(versions_with_dates, key=lambda x: x[1])]

    categories = parse_categories_file(args.categories)

    all_settings: Dict[str, Dict] = {}
    per_version_defaults: Dict[str, Dict[str, str]] = {}
    mt_all_settings: Dict[str, Dict] = {}
    mt_per_version_defaults: Dict[str, Dict[str, str]] = {}
    fmt_all_settings: Dict[str, Dict] = {}
    fmt_per_version_defaults: Dict[str, Dict[str, str]] = {}

    for v in versions_sorted:
        extracted = extract_from_version(args.repo, v, categories)
        per_version_defaults[v] = {}
        for name, info in extracted.items():
            per_version_defaults[v][name] = info["default"]
            if name not in all_settings:
                all_settings[name] = {
                    "name": name,
                    "type": info["type"],
                    "description": info["description"],
                    "flags": info["flags"],
                    "alias": info["alias"],
                    "category": info["category"],
                    "cloud_only": bool(info.get("cloud_only", False)),
                    "versions": {},
                }
            else:
                # Preserve earliest info; update cloud flag if any version marks it
                if info.get("cloud_only"):
                    all_settings[name]["cloud_only"] = True
            # Keep earliest type/description/category seen, but update if empty
            all_settings[name]["versions"][v] = {
                "default": info["default"],
                "tier": info.get("tier", "production"),
                "important": bool(info.get("important", False)),
            }
        # MergeTree settings
        mt_extracted = extract_mergetree_from_version(args.repo, v, categories)
        mt_per_version_defaults[v] = {}
        for name, info in mt_extracted.items():
            mt_per_version_defaults[v][name] = info["default"]
            if name not in mt_all_settings:
                mt_all_settings[name] = {
                    "name": name,
                    "type": info["type"],
                    "description": info["description"],
                    "flags": info["flags"],
                    "alias": info["alias"],
                    "category": info["category"],
                    "cloud_only": bool(info.get("cloud_only", False)),
                    "versions": {},
                }
            else:
                if info.get("cloud_only"):
                    mt_all_settings[name]["cloud_only"] = True
            mt_all_settings[name]["versions"][v] = {
                "default": info["default"],
                "tier": info.get("tier", "production"),
                "important": bool(info.get("important", False)),
            }
        # Format settings
        fmt_extracted = extract_format_from_version(args.repo, v, categories)
        fmt_per_version_defaults[v] = {}
        for name, info in fmt_extracted.items():
            fmt_per_version_defaults[v][name] = info["default"]
            if name not in fmt_all_settings:
                fmt_all_settings[name] = {
                    "name": name,
                    "type": info["type"],
                    "description": info["description"],
                    "flags": info["flags"],
                    "alias": info["alias"],
                    "category": info["category"],
                    "cloud_only": bool(info.get("cloud_only", False)),
                    "versions": {},
                    "docs_url": info.get("docs_url"),
                }
            else:
                if info.get("cloud_only"):
                    fmt_all_settings[name]["cloud_only"] = True
            fmt_all_settings[name]["versions"][v] = {
                "default": info["default"],
                "tier": info.get("tier", "production"),
                "important": bool(info.get("important", False)),
            }

    # Compute introduced_in / removed_in
    for name, info in all_settings.items():
        present = [v for v in versions_sorted if name in per_version_defaults.get(v, {})]
        info["introduced_in"] = present[0] if present else None
        info["removed_in"] = None
        if present and present[-1] != versions_sorted[-1]:
            # Missing in last version, assume removed after last present
            last_idx = versions_sorted.index(present[-1])
            if last_idx + 1 < len(versions_sorted):
                info["removed_in"] = versions_sorted[last_idx + 1]
    for name, info in mt_all_settings.items():
        present = [v for v in versions_sorted if name in mt_per_version_defaults.get(v, {})]
        info["introduced_in"] = present[0] if present else None
        info["removed_in"] = None
        if present and present[-1] != versions_sorted[-1]:
            last_idx = versions_sorted.index(present[-1])
            if last_idx + 1 < len(versions_sorted):
                info["removed_in"] = versions_sorted[last_idx + 1]
    for name, info in fmt_all_settings.items():
        present = [v for v in versions_sorted if name in fmt_per_version_defaults.get(v, {})]
        info["introduced_in"] = present[0] if present else None
        info["removed_in"] = None
        if present and present[-1] != versions_sorted[-1]:
            last_idx = versions_sorted.index(present[-1])
            if last_idx + 1 < len(versions_sorted):
                info["removed_in"] = versions_sorted[last_idx + 1]

    # Compute changed flags between adjacent selected versions per setting
    for name, info in all_settings.items():
        prev_default = None
        for v in versions_sorted:
            if v in info["versions"]:
                cur_default = info["versions"][v]["default"]
                info["versions"][v]["changed_from_prev"] = (prev_default is not None and cur_default != prev_default)
                prev_default = cur_default
            else:
                prev_default = prev_default
    for name, info in mt_all_settings.items():
        prev_default = None
        for v in versions_sorted:
            if v in info["versions"]:
                cur_default = info["versions"][v]["default"]
                info["versions"][v]["changed_from_prev"] = (prev_default is not None and cur_default != prev_default)
                prev_default = cur_default
            else:
                prev_default = prev_default
    for name, info in fmt_all_settings.items():
        prev_default = None
        for v in versions_sorted:
            if v in info["versions"]:
                cur_default = info["versions"][v]["default"]
                info["versions"][v]["changed_from_prev"] = (prev_default is not None and cur_default != prev_default)
                prev_default = cur_default
            else:
                prev_default = prev_default

    # Parse SettingsChangesHistory for version history metadata (using the newest selected version)
    history_src = git_show(args.repo, versions_sorted[-1], "src/Core/SettingsChangesHistory.cpp") if versions_sorted else None
    if history_src:
        history = parse_settings_changes_history(history_src)
        for name, lst in history.items():
            if name in all_settings:
                all_settings[name]["history"] = lst
            if name in mt_all_settings:
                mt_all_settings[name]["history"] = lst
            if name in fmt_all_settings:
                fmt_all_settings[name]["history"] = lst

    output = {
        "versions": versions_sorted,
        "settings": sorted(all_settings.values(), key=lambda x: x["name"].lower()),
        "merge_tree_settings": sorted(mt_all_settings.values(), key=lambda x: x["name"].lower()),
        "format_settings": sorted(fmt_all_settings.values(), key=lambda x: x["name"].lower()),
        "generated_by": "extract_settings.py",
    }

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"Wrote {args.out} with {len(all_settings)} settings across {len(versions_sorted)} version(s)")


if __name__ == "__main__":
    main()
