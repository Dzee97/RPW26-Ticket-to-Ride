#!/usr/bin/env python3
"""
Build the Public Transport Game network from per-line GeoJSON endpoints.

Input
-----
A headerless TSV with four columns:

    agency_id    line_ref    line_name    geojson_url

Example:

    QBUZZ    20    Noordwijk - Leiden    https://.../kaart/QBUZZ:z020

Each endpoint is expected to return a GeoJSON FeatureCollection containing:
- LineString (or MultiLineString) route shapes with route metadata.
- Point stops with at least:
    properties.stop_id
    properties.stop_name

Outputs
-------
1. bus_network.geojson
   Combined route shapes + one merged Point feature per game stop.

2. stops.csv
   One row per merged game stop.

3. line_stops.csv
   Ordered stop sequences reconstructed for every route shape.

4. stop_merge_report.csv
   Audit trail for the two-pass exact-name + spatial stop merging.

5. web_network.geojson
   Lightweight mobile/frontend version of the network: route geometry plus
   only the line/stop properties used by the web app. Route geometry is
   simplified with a small configurable tolerance; stop coordinates are exact.

6. game_edges.geojson
   One feature per undirected game-graph edge (adjacent merged stops), using
   a representative real route geometry between the two stops. This is meant
   as a lightweight ownership overlay for the mobile web interface.

Design choices
--------------
* Game-stop identity is the normalized source `stop_name`, with only
  trailing platform annotations such as "(Perron A)" and "(Uitstaphalte)"
  removed. This lets lines interchange at the same physical station while
  retaining other source distinctions such as "Leiden CS Westzijde".
  The source already includes locality in names such as "Leiden, Steenstraat".

* Stop coordinates are averaged in two stages:
    1. average all same-name point features within one line endpoint;
    2. average those per-line coordinates across lines.
  This gives each line equal weight and prevents a line with two directional
  platform records from counting twice as heavily as another line.

* `line_id` is derived from the endpoint URL, e.g. "QBUZZ:z020".
  This is the stable logical-line identifier in these outputs. `line_ref`
  stores the public line number ("20"). This distinguishes cases where the
  same public number appears in more than one selected endpoint.

* Stop reconciliation is deliberately general and happens in two passes:
    1. all stops with the same normalized name are merged first and their
       per-line coordinates are averaged;
    2. the resulting distinct-name stops are spatially clustered whenever
       they are within a configurable distance of each other.
  City names and operator names do not constrain the spatial pass. This means
  synonyms for the same locality and differently named duplicates within one
  operator are handled the same way as cross-operator duplicates.

* Spatial merging uses connected components: if A is close to B and B is close
  to C, all three become one physical game stop. When a merged cluster contains
  any QBUZZ-labelled stop, a QBUZZ name is retained. If several QBUZZ names are
  present, the name occurring on the most selected QBUZZ lines wins
  deterministically. If no QBUZZ name is present, the most represented name
  across all selected lines is retained. All original names/IDs remain as
  provenance.

* The source does not provide an explicit stop sequence per route shape.
  Sequences are reconstructed by projecting merged per-line stop coordinates
  onto each route shape and sorting them by along-shape distance.

* A configurable maximum point-to-shape distance controls which stops are
  considered served by a shape. The default (60 m) works well for the supplied
  examples, including opposite platforms whose averaged coordinate can sit
  several tens of metres from the route centreline.

* Route shapes that form a loop get their first inferred stop appended again
  at the end of the sequence so the graph contains the closing edge.

* For the web interface, each pair of adjacent stops is also exported once in
  `game_edges.geojson`. If an edge appears in multiple route variants, the
  representative geometry whose endpoint projections fit the source shape
  best is retained, while all serving logical lines are aggregated in the
  feature properties. This avoids shipping thousands of duplicate fragments
  to mobile clients.

The script uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULT_LINES_TSV = Path("bus_lines_new.tsv")
DEFAULT_OUTPUT_DIR = Path("network_output")
DEFAULT_MAX_STOP_DISTANCE_M = 60.0
DEFAULT_LOOP_CLOSURE_DISTANCE_M = 150.0
DEFAULT_STOP_MERGE_DISTANCE_M = 75.0
DEFAULT_PREFERRED_STOP_NAME_AGENCY = "QBUZZ"
DEFAULT_WEB_SIMPLIFY_DISTANCE_M = 5.0
DEFAULT_DOWNLOAD_TIMEOUT_S = 30.0

USER_AGENT = (
    "PublicTransportGameNetworkBuilder/1.0 "
    "(GeoJSON aggregation script)"
)


# ---------------------------------------------------------------------------
# Small data structures
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class LineSpec:
    agency_id: str
    line_ref: str
    line_name: str
    url: str
    line_id: str


@dataclass
class Projection:
    distance_m: float
    along_m: float
    total_m: float


# ---------------------------------------------------------------------------
# Input parsing / identifiers
# ---------------------------------------------------------------------------

def normalize_text(value: Any) -> str:
    """Normalize user/source text without changing its visible meaning."""
    return unicodedata.normalize("NFC", str(value or "")).strip()


_PLATFORM_SUFFIX_RE = re.compile(
    r"\s*\((?:perron\b[^)]*|uitstaphalte\b[^)]*)\)\s*$",
    flags=re.IGNORECASE,
)


def canonical_stop_name(source_stop_name: str) -> str:
    """
    Convert source platform labels into a game-level physical stop name.

    Examples:
        "Leiden, Station Leiden Centraal (Perron A)"
        "Leiden, Station Leiden Centraal (Perron H)"
        "Leiden, Station Leiden Centraal (Uitstaphalte)"
            -> "Leiden, Station Leiden Centraal"

    Other distinctions in the source name are retained. For example,
    "Leiden, Leiden CS Westzijde" is not merged with the main station.
    """
    name = normalize_text(source_stop_name)
    return _PLATFORM_SUFFIX_RE.sub("", name).strip()


def endpoint_key(url: str) -> str:
    """
    Derive the stable source/line identifier from the endpoint URL.

    Example:
        .../kaart/QBUZZ:z020 -> QBUZZ:z020
        .../kaart/EBS:3043  -> EBS:3043
    """
    parsed = urllib.parse.urlparse(url)
    tail = urllib.parse.unquote(parsed.path.rstrip("/").split("/")[-1])
    if not tail:
        raise ValueError(f"Could not derive line_id from URL: {url}")
    return tail


def safe_filename(value: str) -> str:
    value = normalize_text(value)
    value = re.sub(r"[^A-Za-z0-9._-]+", "_", value)
    return value.strip("._") or "line"


def slugify(value: str) -> str:
    ascii_text = (
        unicodedata.normalize("NFKD", value)
        .encode("ascii", "ignore")
        .decode("ascii")
        .lower()
    )
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text).strip("-")
    return slug[:60] or "stop"


def make_stop_id(stop_name: str) -> str:
    """
    Stable synthetic game-stop ID based solely on normalized stop_name.
    """
    canonical = normalize_text(stop_name)
    digest = hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:10]
    return f"stop/{slugify(canonical)}__{digest}"


def split_stop_name(stop_name: str) -> tuple[str, str]:
    """
    Split "City, Stop name" into separate display fields.

    If there is no comma, city is left empty rather than guessed.
    """
    if "," not in stop_name:
        return "", stop_name
    city, name = stop_name.split(",", 1)
    return city.strip(), name.strip()



class UnionFind:
    """Small union-find/disjoint-set structure for spatial stop clustering."""

    def __init__(self, size: int) -> None:
        self.parent = list(range(size))
        self.rank = [0] * size

    def find(self, item: int) -> int:
        parent = self.parent[item]
        if parent != item:
            self.parent[item] = self.find(parent)
        return self.parent[item]

    def union(self, a: int, b: int) -> None:
        root_a = self.find(a)
        root_b = self.find(b)

        if root_a == root_b:
            return

        if self.rank[root_a] < self.rank[root_b]:
            root_a, root_b = root_b, root_a

        self.parent[root_b] = root_a

        if self.rank[root_a] == self.rank[root_b]:
            self.rank[root_a] += 1


def aggregate_exact_name_stop_groups(
    line_records: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """
    First reconciliation pass: merge every stop with the exact same normalized
    name, regardless of agency.

    Each selected line contributes one coordinate sample because
    extract_line_local_stops() has already averaged duplicate Point features
    with that name inside one endpoint.
    """
    coordinates: dict[str, list[tuple[float, float]]] = defaultdict(list)
    line_ids: dict[str, set[str]] = defaultdict(set)
    agencies: dict[str, set[str]] = defaultdict(set)
    agency_line_counts: dict[str, dict[str, int]] = defaultdict(
        lambda: defaultdict(int)
    )

    for record in line_records:
        spec: LineSpec = record["spec"]

        for stop_name, stop in record["local_stops"].items():
            coordinates[stop_name].append(stop["coordinate"])
            line_ids[stop_name].add(spec.line_id)
            agencies[stop_name].add(spec.agency_id)
            agency_line_counts[stop_name][spec.agency_id] += 1

    groups: dict[str, dict[str, Any]] = {}

    for stop_name, samples in coordinates.items():
        groups[stop_name] = {
            "stop_name": stop_name,
            "coordinate": average_coordinates(samples),
            "line_ids": sorted(line_ids[stop_name], key=natural_sort_key),
            "agencies": sorted(agencies[stop_name]),
            "line_sample_count": len(samples),
            "agency_line_counts": dict(agency_line_counts[stop_name]),
        }

    return groups


def choose_cluster_canonical_name(
    members: list[dict[str, Any]],
    *,
    preferred_agency: str,
) -> tuple[str, str]:
    """
    Pick the visible name for one spatial cluster.

    Preferred-agency names always beat non-preferred names. Among multiple
    preferred names, use the one occurring on the greatest number of selected
    preferred-agency lines, then the greatest total line count, then a stable
    natural sort. Without a preferred-agency name, use the most represented
    name across all selected lines.
    """
    preferred_key = preferred_agency.casefold()

    def preferred_count(group: dict[str, Any]) -> int:
        return sum(
            count
            for agency, count in group["agency_line_counts"].items()
            if agency.casefold() == preferred_key
        )

    preferred_members = [
        group for group in members if preferred_count(group) > 0
    ]

    if preferred_members:
        ordered = sorted(
            preferred_members,
            key=lambda group: (
                -preferred_count(group),
                -group["line_sample_count"],
                natural_sort_key(group["stop_name"]),
            ),
        )
        return ordered[0]["stop_name"], preferred_agency

    ordered = sorted(
        members,
        key=lambda group: (
            -group["line_sample_count"],
            natural_sort_key(group["stop_name"]),
        ),
    )
    winner = ordered[0]

    # Exact-name groups may already contain several agencies. Use the first
    # stable agency name only as provenance when no preferred agency is present.
    source_agency = sorted(
        winner["agencies"],
        key=lambda value: value.casefold(),
    )[0] if winner["agencies"] else ""

    return winner["stop_name"], source_agency


def resolve_spatial_stop_names(
    line_records: list[dict[str, Any]],
    *,
    preferred_agency: str,
    merge_distance_m: float,
) -> tuple[
    dict[str, str],
    dict[str, tuple[float, float]],
    dict[str, str],
    list[dict[str, Any]],
]:
    """
    Resolve all game stops using the requested two-pass rule.

    Pass 1
    ------
    Exact normalized names are merged globally and coordinates averaged.

    Pass 2
    ------
    Build an undirected graph between every pair of pass-1 stops whose
    coordinates are at most merge_distance_m apart. Connected components of
    that graph are the final physical stops.

    A spatial grid is used so this remains effectively linear for a regional
    network instead of checking every possible pair.

    Returns
    -------
    aliases:
        exact pass-1 stop name -> final canonical stop name

    canonical_coordinates:
        final canonical stop name -> average coordinate of all distinct-name
        pass-1 stops in that spatial component

    canonical_name_source_agency:
        final canonical stop name -> agency whose name won

    report:
        one row per pass-1 stop name, including exact-name-only groups and
        proximity merges, for auditing
    """
    if merge_distance_m <= 0:
        raise ValueError("merge_distance_m must be positive")

    groups_by_name = aggregate_exact_name_stop_groups(line_records)
    groups = sorted(
        groups_by_name.values(),
        key=lambda group: natural_sort_key(group["stop_name"]),
    )

    if not groups:
        return {}, {}, {}, []

    reference_lat = (
        sum(group["coordinate"][1] for group in groups) / len(groups)
    )

    xy = [
        lonlat_to_xy(
            group["coordinate"][0],
            group["coordinate"][1],
            reference_lat=reference_lat,
        )
        for group in groups
    ]

    union_find = UnionFind(len(groups))
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    cell_size = merge_distance_m

    for index, (x, y) in enumerate(xy):
        cell = (
            math.floor(x / cell_size),
            math.floor(y / cell_size),
        )

        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for other_index in grid.get(
                    (cell[0] + dx, cell[1] + dy),
                    [],
                ):
                    if haversine_m(
                        groups[index]["coordinate"],
                        groups[other_index]["coordinate"],
                    ) <= merge_distance_m:
                        union_find.union(index, other_index)

        grid[cell].append(index)

    component_indexes: dict[int, list[int]] = defaultdict(list)

    for index in range(len(groups)):
        component_indexes[union_find.find(index)].append(index)

    aliases: dict[str, str] = {}
    canonical_coordinates: dict[str, tuple[float, float]] = {}
    canonical_name_source_agency: dict[str, str] = {}
    report: list[dict[str, Any]] = []

    # Stable cluster numbering helps make the audit file reproducible.
    components = sorted(
        component_indexes.values(),
        key=lambda indexes: natural_sort_key(
            min(groups[index]["stop_name"] for index in indexes)
        ),
    )

    for cluster_number, indexes in enumerate(components, start=1):
        members = [groups[index] for index in indexes]

        canonical_name, source_agency = choose_cluster_canonical_name(
            members,
            preferred_agency=preferred_agency,
        )

        cluster_coordinate = average_coordinates(
            member["coordinate"] for member in members
        )

        canonical_coordinates[canonical_name] = cluster_coordinate
        canonical_name_source_agency[canonical_name] = source_agency

        canonical_group = groups_by_name[canonical_name]

        for member in members:
            aliases[member["stop_name"]] = canonical_name

            distance_to_canonical = haversine_m(
                member["coordinate"],
                canonical_group["coordinate"],
            )

            report.append(
                {
                    "status": (
                        "proximity_merged"
                        if member["stop_name"] != canonical_name
                        else (
                            "cluster_canonical"
                            if len(members) > 1
                            else "exact_name_only"
                        )
                    ),
                    "cluster_id": cluster_number,
                    "cluster_size": len(members),
                    "source_stop_name": member["stop_name"],
                    "source_agencies": ", ".join(member["agencies"]),
                    "source_line_count": member["line_sample_count"],
                    "canonical_stop_name": canonical_name,
                    "canonical_name_source_agency": source_agency,
                    "distance_to_canonical_name_m": distance_to_canonical,
                    "source_longitude": member["coordinate"][0],
                    "source_latitude": member["coordinate"][1],
                    "canonical_longitude": cluster_coordinate[0],
                    "canonical_latitude": cluster_coordinate[1],
                }
            )

    return (
        aliases,
        canonical_coordinates,
        canonical_name_source_agency,
        report,
    )



def read_line_specs(path: Path) -> list[LineSpec]:
    specs: list[LineSpec] = []
    seen_line_ids: set[str] = set()

    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter="\t")

        for row_number, row in enumerate(reader, start=1):
            if not row or all(not cell.strip() for cell in row):
                continue

            if len(row) != 4:
                raise ValueError(
                    f"{path}:{row_number}: expected 4 tab-separated columns, "
                    f"got {len(row)}"
                )

            agency_id, line_ref, line_name, url = map(str.strip, row)
            line_id = endpoint_key(url)

            if line_id in seen_line_ids:
                raise ValueError(
                    f"{path}:{row_number}: duplicate endpoint/line_id {line_id!r}"
                )

            seen_line_ids.add(line_id)
            specs.append(
                LineSpec(
                    agency_id=agency_id,
                    line_ref=line_ref,
                    line_name=line_name,
                    url=url,
                    line_id=line_id,
                )
            )

    if not specs:
        raise ValueError(f"No line definitions found in {path}")

    return specs


# ---------------------------------------------------------------------------
# Downloading
# ---------------------------------------------------------------------------

def download_geojson(
    spec: LineSpec,
    raw_dir: Path,
    *,
    refresh: bool,
    timeout_s: float,
) -> dict[str, Any]:
    """
    Download one endpoint, with a persistent local JSON cache.

    Re-running the pipeline does not hit the website again unless --refresh
    is passed.
    """
    raw_dir.mkdir(parents=True, exist_ok=True)
    cache_path = raw_dir / f"{safe_filename(spec.line_id)}.json"

    if cache_path.exists() and not refresh:
        with cache_path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
        validate_feature_collection(data, source=str(cache_path))
        return data

    request = urllib.request.Request(
        spec.url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": "application/geo+json, application/json;q=0.9, */*;q=0.1",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=timeout_s) as response:
            payload = response.read()
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Failed to download {spec.line_id} from {spec.url}: {exc}"
        ) from exc

    try:
        data = json.loads(payload.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(
            f"{spec.url} did not return valid UTF-8 JSON"
        ) from exc

    validate_feature_collection(data, source=spec.url)

    cache_path.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    return data


def validate_feature_collection(data: Any, *, source: str) -> None:
    if not isinstance(data, dict) or data.get("type") != "FeatureCollection":
        raise ValueError(f"{source}: expected GeoJSON FeatureCollection")
    if not isinstance(data.get("features"), list):
        raise ValueError(f"{source}: FeatureCollection has no features list")


# ---------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------

EARTH_RADIUS_M = 6_371_000.0


def lonlat_to_xy(
    lon: float,
    lat: float,
    *,
    reference_lat: float,
) -> tuple[float, float]:
    """
    Local equirectangular projection, accurate enough for point-to-route
    distances at the scale of this regional bus network.
    """
    x = (
        math.radians(lon)
        * EARTH_RADIUS_M
        * math.cos(math.radians(reference_lat))
    )
    y = math.radians(lat) * EARTH_RADIUS_M
    return x, y


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    h = (
        math.sin(dlat / 2.0) ** 2
        + math.cos(lat1)
        * math.cos(lat2)
        * math.sin(dlon / 2.0) ** 2
    )
    return 2.0 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(h)))


def project_point_to_polyline(
    point: tuple[float, float],
    coordinates: list[list[float]] | list[tuple[float, float]],
) -> Projection:
    """
    Return minimum perpendicular distance to the polyline and distance along
    the polyline to the closest projected point.
    """
    if len(coordinates) < 2:
        return Projection(float("inf"), 0.0, 0.0)

    reference_lat = float(point[1])
    px, py = lonlat_to_xy(*point, reference_lat=reference_lat)

    xy = [
        lonlat_to_xy(float(lon), float(lat), reference_lat=reference_lat)
        for lon, lat in coordinates
    ]

    segment_lengths: list[float] = []
    total_m = 0.0

    for a, b in zip(xy, xy[1:]):
        length = math.hypot(b[0] - a[0], b[1] - a[1])
        segment_lengths.append(length)
        total_m += length

    best_distance = float("inf")
    best_along = 0.0
    cumulative = 0.0

    for a, b, segment_length in zip(xy, xy[1:], segment_lengths):
        if segment_length <= 0.0:
            continue

        dx = b[0] - a[0]
        dy = b[1] - a[1]

        t = (
            (px - a[0]) * dx + (py - a[1]) * dy
        ) / (segment_length * segment_length)

        t = max(0.0, min(1.0, t))

        qx = a[0] + t * dx
        qy = a[1] + t * dy

        distance = math.hypot(px - qx, py - qy)

        if distance < best_distance:
            best_distance = distance
            best_along = cumulative + t * segment_length

        cumulative += segment_length

    return Projection(best_distance, best_along, total_m)


def polyline_length_m(
    coordinates: list[list[float]] | list[tuple[float, float]],
) -> float:
    """Return the geodesic length of a polyline in metres."""
    return sum(
        haversine_m(
            (float(a[0]), float(a[1])),
            (float(b[0]), float(b[1])),
        )
        for a, b in zip(coordinates, coordinates[1:])
    )


def interpolate_coordinate(
    a: list[float] | tuple[float, float],
    b: list[float] | tuple[float, float],
    t: float,
) -> list[float]:
    """Linearly interpolate a lon/lat coordinate along a short segment."""
    t = max(0.0, min(1.0, t))
    return [
        float(a[0]) + t * (float(b[0]) - float(a[0])),
        float(a[1]) + t * (float(b[1]) - float(a[1])),
    ]


def slice_polyline_by_fraction(
    coordinates: list[list[float]] | list[tuple[float, float]],
    start_fraction: float,
    end_fraction: float,
) -> list[list[float]]:
    """
    Extract the part of a polyline between two normalized along-route
    positions. Fractions are measured over total geodesic route length.

    The stop-sequence inference stores fractions rather than raw metre offsets
    because point projections use a local projection centred on each stop. The
    normalized position is stable enough to map those projections back onto
    the original GeoJSON coordinate sequence without changing route inference.
    """
    if len(coordinates) < 2:
        return []

    start_fraction = max(0.0, min(1.0, float(start_fraction)))
    end_fraction = max(0.0, min(1.0, float(end_fraction)))

    if end_fraction < start_fraction:
        start_fraction, end_fraction = end_fraction, start_fraction

    segment_lengths = [
        haversine_m(
            (float(a[0]), float(a[1])),
            (float(b[0]), float(b[1])),
        )
        for a, b in zip(coordinates, coordinates[1:])
    ]
    total_m = sum(segment_lengths)

    if total_m <= 0.0:
        return [
            [float(coordinates[0][0]), float(coordinates[0][1])],
            [float(coordinates[-1][0]), float(coordinates[-1][1])],
        ]

    start_m = start_fraction * total_m
    end_m = end_fraction * total_m

    # Degenerate adjacent projections can occur at termini. Give Leaflet a
    # valid two-coordinate LineString rather than an empty geometry.
    if abs(end_m - start_m) < 1e-6:
        end_m = min(total_m, start_m + 1e-3)
        if end_m == start_m:
            start_m = max(0.0, end_m - 1e-3)

    output: list[list[float]] = []
    cumulative = 0.0

    for index, segment_length in enumerate(segment_lengths):
        a = coordinates[index]
        b = coordinates[index + 1]
        segment_start = cumulative
        segment_end = cumulative + segment_length
        cumulative = segment_end

        if segment_length <= 0.0:
            continue

        if segment_end < start_m:
            continue
        if segment_start > end_m:
            break

        local_start = max(start_m, segment_start)
        local_end = min(end_m, segment_end)

        if local_end < local_start:
            continue

        t0 = (local_start - segment_start) / segment_length
        t1 = (local_end - segment_start) / segment_length
        p0 = interpolate_coordinate(a, b, t0)
        p1 = interpolate_coordinate(a, b, t1)

        if not output or output[-1] != p0:
            output.append(p0)
        if output[-1] != p1:
            output.append(p1)

    if len(output) == 1:
        output.append(list(output[0]))

    return output


def make_game_edge_id(stop_a: str, stop_b: str) -> str:
    """Stable ID for one undirected pair of adjacent game stops."""
    left, right = sorted((stop_a, stop_b))
    digest = hashlib.sha1(f"{left}|{right}".encode("utf-8")).hexdigest()[:12]
    return f"edge/{digest}"


def simplify_polyline(
    coordinates: list[list[float]] | list[tuple[float, float]],
    tolerance_m: float,
) -> list[list[float]]:
    """Douglas-Peucker simplification in a local metre-based projection."""
    if len(coordinates) <= 2 or tolerance_m <= 0:
        return [[float(p[0]), float(p[1])] for p in coordinates]

    reference_lat = sum(float(p[1]) for p in coordinates) / len(coordinates)
    xy = [
        lonlat_to_xy(
            float(p[0]),
            float(p[1]),
            reference_lat=reference_lat,
        )
        for p in coordinates
    ]

    keep = [False] * len(coordinates)
    keep[0] = True
    keep[-1] = True
    tolerance_sq = tolerance_m * tolerance_m
    stack = [(0, len(coordinates) - 1)]

    while stack:
        start, end = stack.pop()
        ax, ay = xy[start]
        bx, by = xy[end]
        dx = bx - ax
        dy = by - ay
        denominator = dx * dx + dy * dy

        best_index = -1
        best_distance_sq = -1.0

        for index in range(start + 1, end):
            px, py = xy[index]

            if denominator <= 0.0:
                qx, qy = ax, ay
            else:
                t = ((px - ax) * dx + (py - ay) * dy) / denominator
                t = max(0.0, min(1.0, t))
                qx = ax + t * dx
                qy = ay + t * dy

            distance_sq = (px - qx) ** 2 + (py - qy) ** 2

            if distance_sq > best_distance_sq:
                best_distance_sq = distance_sq
                best_index = index

        if best_distance_sq > tolerance_sq and best_index >= 0:
            keep[best_index] = True
            stack.append((start, best_index))
            stack.append((best_index, end))

    return [
        [float(point[0]), float(point[1])]
        for point, should_keep in zip(coordinates, keep)
        if should_keep
    ]


def build_web_network(
    combined: dict[str, Any],
    *,
    simplify_distance_m: float,
) -> dict[str, Any]:
    """Create the compact static GeoJSON consumed by the mobile web app."""
    features: list[dict[str, Any]] = []

    line_features = [
        feature
        for feature in combined["features"]
        if (feature.get("geometry") or {}).get("type") == "LineString"
    ]

    # Derive served-line membership from the inferred stop sequences, exactly
    # like line_stops.csv and the spreadsheet graph. Do not trust endpoint
    # membership alone: a malformed future source could contain a Point that
    # never matches any route shape.
    line_meta: dict[str, dict[str, str]] = {}
    served_line_ids_by_stop: dict[str, set[str]] = defaultdict(set)

    for feature in line_features:
        props = feature.get("properties") or {}
        line_id = normalize_text(props.get("line_id"))
        if not line_id:
            continue

        line_meta[line_id] = {
            "line_ref": normalize_text(props.get("line_ref")),
            "line_name": normalize_text(props.get("line_name")),
            "agency_id": normalize_text(props.get("agency_id")),
        }

        for occurrence in props.get("stop_sequence", []):
            stop_id = normalize_text(occurrence.get("stop_id"))
            if stop_id:
                served_line_ids_by_stop[stop_id].add(line_id)

    for feature in combined["features"]:
        geometry = feature.get("geometry") or {}
        props = feature.get("properties") or {}
        geom_type = geometry.get("type")

        if geom_type == "LineString":
            features.append(
                {
                    "type": "Feature",
                    "geometry": {
                        "type": "LineString",
                        "coordinates": simplify_polyline(
                            geometry.get("coordinates") or [],
                            simplify_distance_m,
                        ),
                    },
                    "properties": {
                        "line_id": props.get("line_id", ""),
                        "line_ref": props.get("line_ref", ""),
                        "line_name": props.get("line_name", ""),
                        "agency_id": props.get("agency_id", ""),
                        "variant_id": props.get("variant_id", ""),
                    },
                }
            )

        elif geom_type == "Point":
            stop_id = normalize_text(props.get("stop_id"))
            line_ids = sorted(
                served_line_ids_by_stop.get(stop_id, set()),
                key=natural_sort_key,
            )
            line_refs = sorted(
                {
                    line_meta[line_id]["line_ref"]
                    for line_id in line_ids
                    if line_id in line_meta
                },
                key=natural_sort_key,
            )

            features.append(
                {
                    "type": "Feature",
                    "geometry": geometry,
                    "properties": {
                        "stop_id": stop_id,
                        "stop_name": props.get("stop_name", ""),
                        "city": props.get("city", ""),
                        "name": props.get("name", ""),
                        "num_lines": len(line_ids),
                        "line_ids": line_ids,
                        "line_refs": line_refs,
                    },
                }
            )

    return {
        "type": "FeatureCollection",
        "name": "Public Transport Game web network",
        "generated_at": combined.get("generated_at"),
        "source": "bus_network.geojson",
        "route_simplify_distance_m": simplify_distance_m,
        "features": features,
    }


def simplify_game_edges(
    game_edges: dict[str, Any],
    *,
    simplify_distance_m: float,
) -> dict[str, Any]:
    """Simplify game-edge display geometry without changing edge identity."""
    result = dict(game_edges)
    result["route_simplify_distance_m"] = simplify_distance_m
    result["features"] = []

    for feature in game_edges.get("features", []):
        copy = {
            "type": "Feature",
            "geometry": {
                "type": "LineString",
                "coordinates": simplify_polyline(
                    feature["geometry"]["coordinates"],
                    simplify_distance_m,
                ),
            },
            "properties": dict(feature.get("properties") or {}),
        }
        copy["properties"]["length_m"] = round(
            polyline_length_m(copy["geometry"]["coordinates"]),
            1,
        )
        result["features"].append(copy)

    return result


def average_coordinates(
    coordinates: Iterable[tuple[float, float]],
) -> tuple[float, float]:
    coords = list(coordinates)
    if not coords:
        raise ValueError("Cannot average an empty coordinate collection")
    return (
        sum(lon for lon, _ in coords) / len(coords),
        sum(lat for _, lat in coords) / len(coords),
    )


def explode_line_geometry(
    feature: dict[str, Any],
) -> list[tuple[list[list[float]], int | None]]:
    """
    Return one ordered coordinate list per geometry component.

    LineString -> [(coords, None)]
    MultiLineString -> [(part0, 0), (part1, 1), ...]
    """
    geometry = feature.get("geometry") or {}
    geom_type = geometry.get("type")
    coords = geometry.get("coordinates")

    if geom_type == "LineString":
        return [(coords or [], None)]

    if geom_type == "MultiLineString":
        return [
            (part, index)
            for index, part in enumerate(coords or [])
        ]

    return []


# ---------------------------------------------------------------------------
# Source parsing
# ---------------------------------------------------------------------------

def extract_line_local_stops(
    data: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """
    Merge same-name Point features inside one line endpoint.

    Returns keyed by exact normalized stop_name.
    """
    grouped: dict[str, dict[str, Any]] = {}

    coordinates_by_name: dict[str, list[tuple[float, float]]] = defaultdict(list)
    source_ids_by_name: dict[str, set[str]] = defaultdict(set)
    source_names_by_name: dict[str, set[str]] = defaultdict(set)

    for feature in data["features"]:
        geometry = feature.get("geometry") or {}
        if geometry.get("type") != "Point":
            continue

        props = feature.get("properties") or {}
        source_stop_name = normalize_text(props.get("stop_name"))
        stop_name = canonical_stop_name(source_stop_name)

        if not stop_name:
            continue

        coords = geometry.get("coordinates") or []
        if len(coords) < 2:
            continue

        coordinates_by_name[stop_name].append(
            (float(coords[0]), float(coords[1]))
        )

        source_stop_id = normalize_text(props.get("stop_id"))
        if source_stop_id:
            source_ids_by_name[stop_name].add(source_stop_id)

        source_names_by_name[stop_name].add(source_stop_name)

    for stop_name, coordinates in coordinates_by_name.items():
        grouped[stop_name] = {
            "stop_name": stop_name,
            "coordinate": average_coordinates(coordinates),
            "source_stop_ids": sorted(source_ids_by_name[stop_name]),
            "source_stop_names": sorted(source_names_by_name[stop_name]),
            "source_point_count": len(coordinates),
        }

    return grouped


def extract_shapes(
    data: dict[str, Any],
    spec: LineSpec,
) -> list[dict[str, Any]]:
    shapes: list[dict[str, Any]] = []

    for feature_index, feature in enumerate(data["features"]):
        geometry = feature.get("geometry") or {}

        if geometry.get("type") not in {"LineString", "MultiLineString"}:
            continue

        props = dict(feature.get("properties") or {})
        components = explode_line_geometry(feature)

        for coords, part_index in components:
            if len(coords) < 2:
                continue

            source_shape_id = normalize_text(props.get("shape_id"))
            shape_token = source_shape_id or f"feature-{feature_index}"

            if part_index is None:
                variant_id = f"{spec.line_id}|{shape_token}"
            else:
                variant_id = f"{spec.line_id}|{shape_token}|part-{part_index + 1}"

            shapes.append(
                {
                    "geometry": {
                        "type": "LineString",
                        "coordinates": coords,
                    },
                    "source_properties": props,
                    "variant_id": variant_id,
                    "shape_id": source_shape_id,
                    "part_index": part_index,
                }
            )

    if not shapes:
        raise ValueError(f"{spec.line_id}: endpoint contains no route shapes")

    return shapes


def infer_shape_stop_sequence(
    coordinates: list[list[float]],
    local_stops: dict[str, dict[str, Any]],
    canonical_name_by_local_name: dict[str, str],
    *,
    max_distance_m: float,
    loop_closure_distance_m: float,
) -> tuple[list[dict[str, Any]], bool]:
    candidates: list[dict[str, Any]] = []

    for stop_name, stop in local_stops.items():
        projection = project_point_to_polyline(
            stop["coordinate"],
            coordinates,
        )

        if projection.distance_m <= max_distance_m:
            canonical_name = canonical_name_by_local_name.get(
                stop_name, stop_name
            )
            candidates.append(
                {
                    "local_stop_name": stop_name,
                    "stop_name": canonical_name,
                    "stop_id": make_stop_id(canonical_name),
                    "distance_to_shape_m": projection.distance_m,
                    "along_shape_m": projection.along_m,
                    "along_shape_fraction": (
                        projection.along_m / projection.total_m
                        if projection.total_m > 0.0
                        else 0.0
                    ),
                }
            )

    candidates.sort(
        key=lambda item: (
            item["along_shape_m"],
            item["distance_to_shape_m"],
            item["stop_name"],
        )
    )

    # Defensive collapse if source peculiarities produce adjacent duplicates.
    sequence: list[dict[str, Any]] = []

    for candidate in candidates:
        if sequence and sequence[-1]["stop_id"] == candidate["stop_id"]:
            if (
                candidate["distance_to_shape_m"]
                < sequence[-1]["distance_to_shape_m"]
            ):
                sequence[-1] = candidate
            continue
        sequence.append(candidate)

    is_loop = (
        len(coordinates) >= 2
        and haversine_m(
            (float(coordinates[0][0]), float(coordinates[0][1])),
            (float(coordinates[-1][0]), float(coordinates[-1][1])),
        )
        <= loop_closure_distance_m
    )

    # A ring route needs an explicit closing occurrence so line_stops.csv
    # carries the graph edge from its final inferred stop back to its first.
    if (
        is_loop
        and len(sequence) >= 3
        and sequence[0]["stop_id"] != sequence[-1]["stop_id"]
    ):
        closing = dict(sequence[0])
        closing["is_loop_closure"] = True
        closing_projection = project_point_to_polyline(
            local_stops[closing["local_stop_name"]]["coordinate"],
            coordinates,
        )
        closing["along_shape_m"] = closing_projection.total_m
        closing["along_shape_fraction"] = 1.0
        sequence.append(closing)

    for order, item in enumerate(sequence, start=1):
        item["stop_order"] = order
        item.setdefault("is_loop_closure", False)

    return sequence, is_loop


# ---------------------------------------------------------------------------
# Combined network construction
# ---------------------------------------------------------------------------

def build_combined_network(
    specs_and_data: list[tuple[LineSpec, dict[str, Any]]],
    *,
    max_stop_distance_m: float,
    loop_closure_distance_m: float,
    preferred_stop_name_agency: str,
    stop_merge_distance_m: float,
) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, Any]]:
    line_features: list[dict[str, Any]] = []

    # One record per undirected adjacency in the game graph. Each route shape
    # may contribute a geometry candidate; only the best representative is
    # retained while serving-line metadata is aggregated.
    game_edge_records: dict[tuple[str, str], dict[str, Any]] = {}

    # First parse every line independently. Global exact-name aggregation and
    # spatial clustering are done only after every selected line is available.
    line_records: list[dict[str, Any]] = []

    for spec, data in specs_and_data:
        local_stops = extract_line_local_stops(data)
        shapes = extract_shapes(data, spec)

        if not local_stops:
            raise ValueError(
                f"{spec.line_id}: endpoint contains no usable stop Points"
            )

        line_records.append(
            {
                "spec": spec,
                "local_stops": local_stops,
                "shapes": shapes,
            }
        )

    (
        aliases,
        canonical_coordinates,
        canonical_name_source_agency,
        merge_report,
    ) = resolve_spatial_stop_names(
        line_records,
        preferred_agency=preferred_stop_name_agency,
        merge_distance_m=stop_merge_distance_m,
    )

    proximity_rows = [
        row for row in merge_report
        if row["status"] == "proximity_merged"
    ]
    merged_clusters = {
        row["cluster_id"]
        for row in merge_report
        if row["cluster_size"] > 1
    }

    print(
        f"Stop reconciliation: {len(merged_clusters)} spatial cluster(s), "
        f"{len(proximity_rows)} distinct-name stop(s) merged within "
        f"{stop_merge_distance_m:g} m",
        file=sys.stderr,
    )

    for row in proximity_rows[:30]:
        print(
            f"  MERGE {row['source_stop_name']} -> "
            f"{row['canonical_stop_name']} "
            f"(canonical name: {row['canonical_name_source_agency']}; "
            f"{row['distance_to_canonical_name_m']:.1f} m from canonical-name "
            f"group)",
            file=sys.stderr,
        )

    if len(proximity_rows) > 30:
        print(
            f"  ... and {len(proximity_rows) - 30} more proximity merges",
            file=sys.stderr,
        )

    # Global stop aggregation. Final coordinates come directly from the
    # two-pass reconciler: exact-name means first, then spatial-cluster means.
    global_stops: dict[str, dict[str, Any]] = {}

    for record in line_records:
        spec: LineSpec = record["spec"]
        local_stops = record["local_stops"]
        shapes = record["shapes"]

        canonical_name_by_local_name = {
            stop_name: aliases.get(stop_name, stop_name)
            for stop_name in local_stops
        }

        route_ids = sorted(
            {
                normalize_text(
                    (shape["source_properties"] or {}).get("route_id")
                )
                for shape in shapes
                if normalize_text(
                    (shape["source_properties"] or {}).get("route_id")
                )
            }
        )

        source_route_short_names = sorted(
            {
                normalize_text(
                    (shape["source_properties"] or {}).get("route_short_name")
                )
                for shape in shapes
                if normalize_text(
                    (shape["source_properties"] or {}).get("route_short_name")
                )
            }
        )

        if (
            source_route_short_names
            and spec.line_ref not in source_route_short_names
        ):
            print(
                f"WARNING {spec.line_id}: TSV line_ref={spec.line_ref!r}, "
                f"source route_short_name={source_route_short_names!r}",
                file=sys.stderr,
            )

        relation = {
            "line_id": spec.line_id,
            "line_ref": spec.line_ref,
            "line_name": spec.line_name,
            "agency_id": spec.agency_id,
            "source_url": spec.url,
            "route_ids": route_ids,
        }

        for local_stop_name, local in local_stops.items():
            stop_name = canonical_name_by_local_name[local_stop_name]
            stop_id = make_stop_id(stop_name)
            city, name = split_stop_name(stop_name)

            if stop_id not in global_stops:
                global_stops[stop_id] = {
                    "stop_id": stop_id,
                    "stop_name": stop_name,
                    "city": city,
                    "name": name,
                    "name_source_agency": (
                        canonical_name_source_agency.get(
                            stop_name,
                            spec.agency_id,
                        )
                    ),
                    "coordinate": canonical_coordinates[stop_name],
                    "relations": {},
                    "source_agencies": set(),
                    "source_stop_ids": set(),
                    "source_stop_names": set(),
                    "source_point_count": 0,
                }

            target = global_stops[stop_id]

            if target["stop_name"] != stop_name:
                raise RuntimeError(
                    "Synthetic stop ID collision between "
                    f"{target['stop_name']!r} and {stop_name!r}"
                )

            target["relations"][spec.line_id] = relation
            target["source_agencies"].add(spec.agency_id)
            target["source_stop_ids"].update(local["source_stop_ids"])
            target["source_stop_names"].update(local["source_stop_names"])
            target["source_point_count"] += local["source_point_count"]

        # Track matched *canonical* stops rather than original local names.
        #
        # After the proximity-merging pass, multiple differently named local
        # stops can map to the same final game stop. infer_shape_stop_sequence()
        # deliberately collapses adjacent candidates with the same canonical
        # stop_id and keeps the candidate closest to the route shape. If we
        # tracked local_stop_name here, the discarded alias would incorrectly
        # be reported as unmatched even though its final merged stop is already
        # represented in the sequence.
        matched_canonical_stop_names: set[str] = set()

        for shape in shapes:
            sequence, is_loop = infer_shape_stop_sequence(
                shape["geometry"]["coordinates"],
                local_stops,
                canonical_name_by_local_name,
                max_distance_m=max_stop_distance_m,
                loop_closure_distance_m=loop_closure_distance_m,
            )

            matched_canonical_stop_names.update(
                item["stop_name"]
                for item in sequence
                if not item["is_loop_closure"]
            )

            source_props = dict(shape["source_properties"])
            headsigns = source_props.get("headsigns")

            if isinstance(headsigns, list):
                headsign = " / ".join(
                    normalize_text(value)
                    for value in headsigns
                    if normalize_text(value)
                )
            else:
                headsign = normalize_text(headsigns)

            combined_props = {
                **source_props,
                "line_id": spec.line_id,
                "line_ref": spec.line_ref,
                "line_name": spec.line_name,
                "source_url": spec.url,
                "variant_id": shape["variant_id"],
                "headsign": headsign,
                "is_loop": is_loop,
                "stop_count": len(
                    [x for x in sequence if not x["is_loop_closure"]]
                ),
                "stop_sequence": [
                    {
                        "stop_order": item["stop_order"],
                        "stop_id": item["stop_id"],
                        "stop_name": item["stop_name"],
                        "source_stop_name": item["local_stop_name"],
                        "distance_to_shape_m": round(
                            item["distance_to_shape_m"], 3
                        ),
                        "is_loop_closure": item["is_loop_closure"],
                    }
                    for item in sequence
                ],
            }

            if shape["part_index"] is not None:
                combined_props["geometry_part"] = shape["part_index"] + 1

            # Build the lightweight web-overlay edges from the same inferred
            # sequence that drives line_stops.csv and spreadsheet graph
            # scoring. Thus the frontend cannot disagree with the game graph.
            shape_coordinates = shape["geometry"]["coordinates"]

            for first, second in zip(sequence, sequence[1:]):
                if first["stop_id"] == second["stop_id"]:
                    continue

                edge_key = tuple(sorted((
                    first["stop_id"],
                    second["stop_id"],
                )))

                segment = slice_polyline_by_fraction(
                    shape_coordinates,
                    first["along_shape_fraction"],
                    second["along_shape_fraction"],
                )

                if len(segment) < 2:
                    continue

                # Orient the representative geometry from stop_a to stop_b for
                # deterministic output, even when the source shape travels the
                # opposite direction.
                if first["stop_id"] != edge_key[0]:
                    segment = list(reversed(segment))

                candidate_rank = (
                    float(first["distance_to_shape_m"])
                    + float(second["distance_to_shape_m"]),
                    -len(segment),
                    shape["variant_id"],
                )

                record = game_edge_records.get(edge_key)

                if record is None:
                    record = {
                        "stop_a": edge_key[0],
                        "stop_b": edge_key[1],
                        "lines": {},
                        "variant_ids": set(),
                        "representative_geometry": segment,
                        "representative_rank": candidate_rank,
                        "representative_variant_id": shape["variant_id"],
                    }
                    game_edge_records[edge_key] = record
                elif candidate_rank < record["representative_rank"]:
                    record["representative_geometry"] = segment
                    record["representative_rank"] = candidate_rank
                    record["representative_variant_id"] = shape["variant_id"]

                record["lines"][spec.line_id] = {
                    "line_id": spec.line_id,
                    "line_ref": spec.line_ref,
                    "line_name": spec.line_name,
                    "agency_id": spec.agency_id,
                }
                record["variant_ids"].add(shape["variant_id"])

            line_features.append(
                {
                    "type": "Feature",
                    "geometry": shape["geometry"],
                    "properties": combined_props,
                }
            )

        # Warn only when a *final canonical stop* represented on this line
        # could not be matched to any route shape. Aliases that merged into an
        # already matched canonical stop are not genuine missing stops.
        expected_canonical_stop_names = {
            canonical_name_by_local_name[local_name]
            for local_name in local_stops
        }

        unmatched = sorted(
            expected_canonical_stop_names - matched_canonical_stop_names,
            key=natural_sort_key,
        )

        if unmatched:
            print(
                f"WARNING {spec.line_id}: {len(unmatched)} merged stop(s) were "
                f"not within {max_stop_distance_m:g} m of any route shape:",
                file=sys.stderr,
            )
            for name in unmatched[:10]:
                print(f"  - {name}", file=sys.stderr)
            if len(unmatched) > 10:
                print(
                    f"  ... and {len(unmatched) - 10} more",
                    file=sys.stderr,
                )

        print(
            f"{spec.line_id:14s} "
            f"ref={spec.line_ref:<4s} "
            f"stops={len(local_stops):3d} "
            f"shapes={len(shapes):2d}",
            file=sys.stderr,
        )

    stop_features: list[dict[str, Any]] = []

    for stop_id, stop in global_stops.items():
        lon, lat = stop["coordinate"]
        relations = sorted(
            stop["relations"].values(),
            key=lambda rel: natural_sort_key(rel["line_id"]),
        )

        line_ids = [rel["line_id"] for rel in relations]
        line_refs = [rel["line_ref"] for rel in relations]

        stop_features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "Point",
                    "coordinates": [lon, lat],
                },
                "properties": {
                    "stop_id": stop_id,
                    "stop_name": stop["stop_name"],
                    "city": stop["city"],
                    "name": stop["name"],
                    "name_source_agency": stop["name_source_agency"],
                    "num_lines": len(relations),
                    "line_ids": line_ids,
                    "line_refs": line_refs,
                    "relations": relations,
                    "source_agencies": sorted(stop["source_agencies"]),
                    "source_stop_ids": sorted(stop["source_stop_ids"]),
                    "source_stop_names": sorted(stop["source_stop_names"]),
                    "source_point_count": stop["source_point_count"],
                    "coordinate_exact_name_count": sum(
                        1
                        for row in merge_report
                        if row["canonical_stop_name"] == stop["stop_name"]
                    ),
                },
            }
        )

    stop_features.sort(
        key=lambda feature: (
            normalize_text(feature["properties"]["stop_name"]).casefold(),
            feature["properties"]["stop_id"],
        )
    )

    line_features.sort(
        key=lambda feature: (
            natural_sort_key(feature["properties"]["line_id"]),
            feature["properties"]["variant_id"],
        )
    )

    stop_name_by_id = {
        stop_id: stop["stop_name"]
        for stop_id, stop in global_stops.items()
    }

    game_edge_features: list[dict[str, Any]] = []

    for edge_key, record in game_edge_records.items():
        lines = sorted(
            record["lines"].values(),
            key=lambda line: natural_sort_key(line["line_id"]),
        )
        line_refs = sorted(
            {line["line_ref"] for line in lines},
            key=natural_sort_key,
        )

        geometry = record["representative_geometry"]

        game_edge_features.append(
            {
                "type": "Feature",
                "geometry": {
                    "type": "LineString",
                    "coordinates": geometry,
                },
                "properties": {
                    "edge_id": make_game_edge_id(*edge_key),
                    "stop_a": record["stop_a"],
                    "stop_b": record["stop_b"],
                    "stop_a_name": stop_name_by_id[record["stop_a"]],
                    "stop_b_name": stop_name_by_id[record["stop_b"]],
                    "num_lines": len(lines),
                    "line_ids": [line["line_id"] for line in lines],
                    "line_refs": line_refs,
                    "lines": lines,
                    "variant_ids": sorted(
                        record["variant_ids"],
                        key=natural_sort_key,
                    ),
                    "representative_variant_id": (
                        record["representative_variant_id"]
                    ),
                    "length_m": round(polyline_length_m(geometry), 1),
                },
            }
        )

    game_edge_features.sort(
        key=lambda feature: (
            natural_sort_key(feature["properties"]["stop_a_name"]),
            natural_sort_key(feature["properties"]["stop_b_name"]),
            feature["properties"]["edge_id"],
        )
    )

    game_edges = {
        "type": "FeatureCollection",
        "name": "Public Transport Game ownership edges",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "edge_identity": "undirected pair of adjacent merged game stops",
        "geometry_selection": (
            "one representative real route segment per logical edge; "
            "lowest summed endpoint-to-shape projection distance wins"
        ),
        "features": game_edge_features,
    }

    return (
        {
            "type": "FeatureCollection",
            "name": "Public Transport Game bus network",
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "stop_identity": (
                "two-pass exact-name aggregation followed by distance-based "
                "spatial connected-component merging"
            ),
            "preferred_stop_name_agency": preferred_stop_name_agency,
            "stop_merge_distance_m": stop_merge_distance_m,
            "line_identity": "endpoint key from TSV URL",
            "max_stop_shape_distance_m": max_stop_distance_m,
            "loop_closure_distance_m": loop_closure_distance_m,
            "features": line_features + stop_features,
        },
        merge_report,
        game_edges,
    )


def natural_sort_key(value: Any) -> list[tuple[int, Any]]:
    parts = re.split(r"(\d+)", normalize_text(value))
    return [
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in parts
        if part != ""
    ]


# ---------------------------------------------------------------------------
# CSV export from the combined GeoJSON
# ---------------------------------------------------------------------------

def write_csvs_from_combined(
    combined: dict[str, Any],
    *,
    stops_csv: Path,
    line_stops_csv: Path,
) -> None:
    point_features = [
        feature
        for feature in combined["features"]
        if (feature.get("geometry") or {}).get("type") == "Point"
    ]

    line_features = [
        feature
        for feature in combined["features"]
        if (feature.get("geometry") or {}).get("type") == "LineString"
    ]

    stop_name_by_id = {
        feature["properties"]["stop_id"]:
        feature["properties"]["stop_name"]
        for feature in point_features
    }

    with stops_csv.open("w", encoding="utf-8", newline="") as handle:
        fieldnames = [
            "stop_id",
            "stop_name",
            "city",
            "name",
            "longitude",
            "latitude",
            "num_lines",
            "line_ids",
            "line_refs",
            "name_source_agency",
            "source_agencies",
            "source_stop_ids",
            "source_stop_names",
        ]

        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()

        for feature in point_features:
            props = feature["properties"]
            lon, lat = feature["geometry"]["coordinates"]

            writer.writerow(
                {
                    "stop_id": props["stop_id"],
                    "stop_name": props["stop_name"],
                    "city": props["city"],
                    "name": props["name"],
                    "longitude": f"{lon:.7f}",
                    "latitude": f"{lat:.7f}",
                    "num_lines": props["num_lines"],
                    "line_ids": ", ".join(props["line_ids"]),
                    "line_refs": ", ".join(props["line_refs"]),
                    "name_source_agency": props["name_source_agency"],
                    "source_agencies": ", ".join(props["source_agencies"]),
                    "source_stop_ids": ", ".join(
                        props["source_stop_ids"]
                    ),
                    "source_stop_names": " | ".join(
                        props["source_stop_names"]
                    ),
                }
            )

    with line_stops_csv.open(
        "w",
        encoding="utf-8",
        newline="",
    ) as handle:
        fieldnames = [
            "line_id",
            "line_ref",
            "line_name",
            "agency_id",
            "route_id",
            "variant_id",
            "shape_id",
            "headsign",
            "trip_count",
            "stop_order",
            "stop_id",
            "stop_name",
            "distance_to_shape_m",
            "is_loop_closure",
        ]

        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()

        for feature in line_features:
            props = feature["properties"]

            for occurrence in props.get("stop_sequence", []):
                stop_id = occurrence["stop_id"]

                if stop_id not in stop_name_by_id:
                    raise ValueError(
                        f"Route sequence references unknown stop_id {stop_id}"
                    )

                writer.writerow(
                    {
                        "line_id": props.get("line_id", ""),
                        "line_ref": props.get("line_ref", ""),
                        "line_name": props.get("line_name", ""),
                        "agency_id": props.get("agency_id", ""),
                        "route_id": props.get("route_id", ""),
                        "variant_id": props.get("variant_id", ""),
                        "shape_id": props.get("shape_id", ""),
                        "headsign": props.get("headsign", ""),
                        "trip_count": props.get("trip_count", ""),
                        "stop_order": occurrence["stop_order"],
                        "stop_id": stop_id,
                        "stop_name": stop_name_by_id[stop_id],
                        "distance_to_shape_m": (
                            occurrence["distance_to_shape_m"]
                        ),
                        "is_loop_closure": (
                            "1" if occurrence["is_loop_closure"] else "0"
                        ),
                    }
                )


def write_stop_merge_report(
    rows: list[dict[str, Any]],
    path: Path,
) -> None:
    """Write the complete two-pass stop reconciliation audit trail."""
    fieldnames = [
        "status",
        "cluster_id",
        "cluster_size",
        "source_stop_name",
        "source_agencies",
        "source_line_count",
        "canonical_stop_name",
        "canonical_name_source_agency",
        "distance_to_canonical_name_m",
        "source_longitude",
        "source_latitude",
        "canonical_longitude",
        "canonical_latitude",
    ]

    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()

        for row in rows:
            output = dict(row)

            for key in (
                "distance_to_canonical_name_m",
                "source_longitude",
                "source_latitude",
                "canonical_longitude",
                "canonical_latitude",
            ):
                value = output.get(key, "")
                if isinstance(value, (int, float)):
                    precision = 3 if key.endswith("_m") else 7
                    output[key] = f"{value:.{precision}f}"

            writer.writerow(
                {name: output.get(name, "") for name in fieldnames}
            )


# ---------------------------------------------------------------------------
# Validation / diagnostics
# ---------------------------------------------------------------------------

def validate_combined(combined: dict[str, Any]) -> None:
    point_features = [
        f for f in combined["features"]
        if (f.get("geometry") or {}).get("type") == "Point"
    ]
    line_features = [
        f for f in combined["features"]
        if (f.get("geometry") or {}).get("type") == "LineString"
    ]

    stop_ids = [
        f["properties"]["stop_id"]
        for f in point_features
    ]

    if len(stop_ids) != len(set(stop_ids)):
        raise ValueError("Combined GeoJSON contains duplicate game stop IDs")

    stop_id_set = set(stop_ids)

    for feature in line_features:
        props = feature["properties"]
        sequence = props.get("stop_sequence")

        if not isinstance(sequence, list):
            raise ValueError(
                f"{props.get('variant_id')}: missing stop_sequence"
            )

        orders = [item["stop_order"] for item in sequence]
        if orders != list(range(1, len(sequence) + 1)):
            raise ValueError(
                f"{props.get('variant_id')}: non-consecutive stop_order"
            )

        for item in sequence:
            if item["stop_id"] not in stop_id_set:
                raise ValueError(
                    f"{props.get('variant_id')}: unknown stop_id "
                    f"{item['stop_id']}"
                )


def validate_game_edges(
    combined: dict[str, Any],
    game_edges: dict[str, Any],
) -> None:
    """Ensure the web-overlay edge set exactly matches the game graph."""
    point_features = [
        feature
        for feature in combined["features"]
        if (feature.get("geometry") or {}).get("type") == "Point"
    ]
    line_features = [
        feature
        for feature in combined["features"]
        if (feature.get("geometry") or {}).get("type") == "LineString"
    ]

    stop_ids = {
        feature["properties"]["stop_id"]
        for feature in point_features
    }

    expected_lines_by_edge: dict[tuple[str, str], set[str]] = defaultdict(set)

    for feature in line_features:
        props = feature["properties"]
        line_id = props["line_id"]
        sequence = props.get("stop_sequence", [])

        for first, second in zip(sequence, sequence[1:]):
            if first["stop_id"] == second["stop_id"]:
                continue
            key = tuple(sorted((first["stop_id"], second["stop_id"])))
            expected_lines_by_edge[key].add(line_id)

    actual_lines_by_edge: dict[tuple[str, str], set[str]] = {}
    edge_ids: set[str] = set()

    for feature in game_edges.get("features", []):
        geometry = feature.get("geometry") or {}
        props = feature.get("properties") or {}

        if geometry.get("type") != "LineString":
            raise ValueError("game_edges.geojson contains a non-LineString feature")

        coordinates = geometry.get("coordinates") or []
        if len(coordinates) < 2:
            raise ValueError(
                f"{props.get('edge_id')}: game edge has fewer than 2 coordinates"
            )

        stop_a = props.get("stop_a")
        stop_b = props.get("stop_b")

        if stop_a not in stop_ids or stop_b not in stop_ids:
            raise ValueError(
                f"{props.get('edge_id')}: game edge references unknown stop"
            )

        key = tuple(sorted((stop_a, stop_b)))
        if key in actual_lines_by_edge:
            raise ValueError(f"Duplicate logical game edge: {key}")

        edge_id = props.get("edge_id")
        if edge_id in edge_ids:
            raise ValueError(f"Duplicate game edge_id: {edge_id}")
        edge_ids.add(edge_id)

        actual_lines_by_edge[key] = set(props.get("line_ids", []))

    if set(actual_lines_by_edge) != set(expected_lines_by_edge):
        missing = set(expected_lines_by_edge) - set(actual_lines_by_edge)
        extra = set(actual_lines_by_edge) - set(expected_lines_by_edge)
        raise ValueError(
            "game_edges.geojson does not match inferred graph: "
            f"{len(missing)} missing, {len(extra)} extra edge(s)"
        )

    for key, expected_lines in expected_lines_by_edge.items():
        if actual_lines_by_edge[key] != expected_lines:
            raise ValueError(
                f"Game edge {key} has incorrect line_ids: "
                f"expected {sorted(expected_lines)}, "
                f"got {sorted(actual_lines_by_edge[key])}"
            )


def summarize_combined(combined: dict[str, Any]) -> str:
    points = [
        f for f in combined["features"]
        if (f.get("geometry") or {}).get("type") == "Point"
    ]
    lines = [
        f for f in combined["features"]
        if (f.get("geometry") or {}).get("type") == "LineString"
    ]

    logical_lines = {
        f["properties"]["line_id"]
        for f in lines
    }

    sequence_rows = sum(
        len(f["properties"].get("stop_sequence", []))
        for f in lines
    )

    return (
        f"{len(logical_lines)} logical lines, "
        f"{len(lines)} route shapes, "
        f"{len(points)} merged stops, "
        f"{sequence_rows} ordered line-stop occurrences"
    )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Download per-line GeoJSON endpoints and build a combined bus "
            "network, web game-edge overlay, stops.csv and line_stops.csv."
        )
    )

    parser.add_argument(
        "--lines",
        type=Path,
        default=DEFAULT_LINES_TSV,
        help=f"Headerless 4-column TSV (default: {DEFAULT_LINES_TSV})",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"Output directory (default: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--max-stop-distance",
        type=float,
        default=DEFAULT_MAX_STOP_DISTANCE_M,
        help=(
            "Maximum stop-to-shape distance in metres when reconstructing "
            f"shape stop sequences (default: {DEFAULT_MAX_STOP_DISTANCE_M:g})"
        ),
    )
    parser.add_argument(
        "--loop-closure-distance",
        type=float,
        default=DEFAULT_LOOP_CLOSURE_DISTANCE_M,
        help=(
            "Treat a shape as a loop when its endpoints are within this "
            f"distance in metres (default: {DEFAULT_LOOP_CLOSURE_DISTANCE_M:g})"
        ),
    )
    parser.add_argument(
        "--preferred-stop-name-agency",
        default=DEFAULT_PREFERRED_STOP_NAME_AGENCY,
        help=(
            "Agency whose stop name is preferred inside a spatially merged "
            f"cluster (default: {DEFAULT_PREFERRED_STOP_NAME_AGENCY})"
        ),
    )
    parser.add_argument(
        "--stop-merge-distance",
        type=float,
        default=DEFAULT_STOP_MERGE_DISTANCE_M,
        help=(
            "After exact-name averaging, merge every pair of stops within "
            "this distance in metres; connected components become one stop "
            f"(default: {DEFAULT_STOP_MERGE_DISTANCE_M:g})"
        ),
    )
    parser.add_argument(
        "--web-simplify-distance",
        type=float,
        default=DEFAULT_WEB_SIMPLIFY_DISTANCE_M,
        help=(
            "Geometry simplification tolerance in metres for web_network.geojson "
            "and game_edges.geojson; 0 disables simplification "
            f"(default: {DEFAULT_WEB_SIMPLIFY_DISTANCE_M:g})"
        ),
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_DOWNLOAD_TIMEOUT_S,
        help=(
            f"Download timeout per endpoint in seconds "
            f"(default: {DEFAULT_DOWNLOAD_TIMEOUT_S:g})"
        ),
    )
    parser.add_argument(
        "--refresh",
        action="store_true",
        help="Ignore cached raw GeoJSON and re-download every endpoint.",
    )
    parser.add_argument(
        "--download-delay",
        type=float,
        default=0.15,
        help=(
            "Delay between endpoint downloads in seconds "
            "(default: 0.15)"
        ),
    )

    return parser.parse_args()


def main() -> None:
    args = parse_args()

    if args.max_stop_distance <= 0:
        raise ValueError("--max-stop-distance must be positive")
    if args.loop_closure_distance < 0:
        raise ValueError("--loop-closure-distance cannot be negative")
    if args.timeout <= 0:
        raise ValueError("--timeout must be positive")
    if args.stop_merge_distance <= 0:
        raise ValueError("--stop-merge-distance must be positive")
    if args.web_simplify_distance < 0:
        raise ValueError("--web-simplify-distance cannot be negative")

    specs = read_line_specs(args.lines)

    output_dir: Path = args.output_dir
    raw_dir = output_dir / "raw"
    output_dir.mkdir(parents=True, exist_ok=True)

    specs_and_data: list[tuple[LineSpec, dict[str, Any]]] = []

    print(
        f"Loading {len(specs)} selected bus-line endpoints...",
        file=sys.stderr,
    )

    for index, spec in enumerate(specs, start=1):
        print(
            f"[{index:02d}/{len(specs):02d}] {spec.line_id} "
            f"(line {spec.line_ref})",
            file=sys.stderr,
        )

        data = download_geojson(
            spec,
            raw_dir,
            refresh=args.refresh,
            timeout_s=args.timeout,
        )

        specs_and_data.append((spec, data))

        if args.download_delay > 0 and index < len(specs):
            time.sleep(args.download_delay)

    print("Combining network...", file=sys.stderr)

    combined, merge_report, game_edges = build_combined_network(
        specs_and_data,
        max_stop_distance_m=args.max_stop_distance,
        loop_closure_distance_m=args.loop_closure_distance,
        preferred_stop_name_agency=args.preferred_stop_name_agency,
        stop_merge_distance_m=args.stop_merge_distance,
    )

    validate_combined(combined)
    validate_game_edges(combined, game_edges)

    web_network = build_web_network(
        combined,
        simplify_distance_m=args.web_simplify_distance,
    )
    game_edges = simplify_game_edges(
        game_edges,
        simplify_distance_m=args.web_simplify_distance,
    )
    validate_game_edges(combined, game_edges)

    geojson_path = output_dir / "bus_network.geojson"
    web_network_path = output_dir / "web_network.geojson"
    game_edges_path = output_dir / "game_edges.geojson"
    stops_csv_path = output_dir / "stops.csv"
    line_stops_csv_path = output_dir / "line_stops.csv"
    merge_report_path = output_dir / "stop_merge_report.csv"

    geojson_path.write_text(
        json.dumps(
            combined,
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    web_network_path.write_text(
        json.dumps(
            web_network,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )

    game_edges_path.write_text(
        json.dumps(
            game_edges,
            ensure_ascii=False,
            separators=(",", ":"),
        )
        + "\n",
        encoding="utf-8",
    )

    # Generate both CSV files from the already combined GeoJSON object. This
    # makes the combined file the canonical product of the acquisition stage.
    write_csvs_from_combined(
        combined,
        stops_csv=stops_csv_path,
        line_stops_csv=line_stops_csv_path,
    )
    write_stop_merge_report(merge_report, merge_report_path)

    print("", file=sys.stderr)
    print("Done:", file=sys.stderr)
    print(f"  {summarize_combined(combined)}", file=sys.stderr)
    print(f"  GeoJSON:    {geojson_path}", file=sys.stderr)
    print(f"  Web network:{web_network_path}", file=sys.stderr)
    print(
        f"  Game edges: {game_edges_path} "
        f"({len(game_edges['features'])} logical edges)",
        file=sys.stderr,
    )
    print(f"  Stops CSV:  {stops_csv_path}", file=sys.stderr)
    print(f"  Line stops: {line_stops_csv_path}", file=sys.stderr)
    print(f"  Merge log:  {merge_report_path}", file=sys.stderr)
    print(f"  Raw cache:  {raw_dir}", file=sys.stderr)


if __name__ == "__main__":
    main()
