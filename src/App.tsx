import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MapLibreMap, type Marker } from "maplibre-gl";
import {
  Badge,
  Button,
  Card,
  Dialog,
  Flex,
  Heading,
  IconButton,
  ScrollArea,
  Select,
  Separator,
  Slider,
  Switch,
  Tabs,
  Text,
  TextField,
} from "@radix-ui/themes";
import {
  BookOpen,
  Check,
  ChevronLeft,
  Compass,
  Download,
  Layers3,
  MapPin,
  Menu,
  Plus,
  Search,
  Settings2,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  cacheSavedImage,
  DEFAULT_BOOK,
  readState,
  removeSavedImage,
  requestPersistence,
  validateBackup,
  writeState,
  type StoreState,
} from "./storage";

type Stamp = {
  id: string;
  name: string;
  stationName: string;
  operator: string;
  section: string;
  image: string;
  imageBytes: number;
  thumbnail: string;
  thumbnailBytes: number;
  sourcePage: string;
  coordinates?: [number, number];
  lines?: string[];
  stationCode?: string;
  coordinateSource?: string;
  unplacedReason?: string;
  matchNote?: string;
};
type Logo = {
  file: string;
  wikidata: string;
  commons: string;
  license: string;
  attribution: string;
};
type Station = {
  id: string;
  name: string;
  coordinates: [number, number];
  stamps: Stamp[];
};
const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEM = "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp";
const NO_MOTION = matchMedia("(prefers-reduced-motion: reduce)");
const BASE_STAMP_SIZE = 92;
const bytes = (n: number) =>
  n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`;
const cleanName = (s: string) =>
  s
    .replace(/駅$/, "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/〈.*?〉/g, "")
    .replace(/\s/g, "");
const dist = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 90, (a[1] - b[1]) * 111);

function makeStations(stamps: Stamp[]): Station[] {
  const stations: Station[] = [];
  for (const stamp of stamps) {
    if (!stamp.coordinates) continue;
    const existing = stations.find(
      (x) =>
        cleanName(x.name) === cleanName(stamp.stationName) &&
        dist(x.coordinates, stamp.coordinates!) < 0.55,
    );
    if (existing) existing.stamps.push(stamp);
    else
      stations.push({
        id: stamp.id,
        name: stamp.stationName,
        coordinates: stamp.coordinates,
        stamps: [stamp],
      });
  }
  return stations;
}

function LogoBadge({
  operator,
  logos,
}: {
  operator: string;
  logos: Record<string, Logo>;
}) {
  const first = operator.split("・")[0];
  const logo = logos[first];
  return logo ? (
    <img
      className="operator-logo"
      src={logo.file}
      alt={`${first} logo`}
      title={`${first} · ${logo.license}`}
    />
  ) : (
    <Badge variant="soft" color="gray" className="operator-badge">
      {operator}
    </Badge>
  );
}

function MapView({
  stations,
  scale,
  terrain,
  onSelect,
  focus,
}: {
  stations: Station[];
  scale: number;
  terrain: boolean;
  onSelect: (id: string) => void;
  focus: Station | null;
}) {
  const container = useRef<HTMLDivElement>(null);
  const map = useRef<MapLibreMap | null>(null);
  const markers = useRef(new Map<string, Marker>());
  const removeTimers = useRef(new Map<string, number>());
  const preloaded = useRef(new Set<string>());
  const stationsRef = useRef(stations);
  stationsRef.current = stations;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const [mapError, setMapError] = useState(false);
  const [terrainError, setTerrainError] = useState(false);

  useEffect(() => {
    if (!container.current || map.current) return;
    const m = new maplibregl.Map({
      container: container.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: [OSM],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
          },
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }],
      },
      center: [138.3, 36.9],
      zoom: 5.1,
      pitch: 48,
      bearing: -9,
      maxPitch: 75,
      attributionControl: false,
    });
    map.current = m;
    m.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "bottom-right",
    );
    m.addControl(
      new maplibregl.AttributionControl({ compact: false }),
      "bottom-left",
    );
    m.on("error", (e) => {
      const msg = String(e.error?.message || "");
      if (msg.includes("mapterhorn") || msg.includes("terrain"))
        setTerrainError(true);
      else if (msg.includes("tile.openstreetmap")) setMapError(true);
    });
    m.on("load", () => {
      const source = {
        type: "geojson" as const,
        data: {
          type: "FeatureCollection" as const,
          features: [] as GeoJSON.Feature[],
        },
        cluster: true,
        clusterRadius: 55,
        clusterMaxZoom: 9,
      };
      m.addSource("stations", source);
      m.addLayer({
        id: "cluster-halo",
        type: "circle",
        source: "stations",
        filter: ["has", "point_count"],
        paint: {
          "circle-radius": ["step", ["get", "point_count"], 19, 20, 25, 80, 32],
          "circle-color": "#d9ebe4",
          "circle-stroke-color": "#398267",
          "circle-stroke-width": 2,
          "circle-opacity": 0.94,
        },
      });
      m.addLayer({
        id: "cluster-count",
        type: "symbol",
        source: "stations",
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-size": 13,
        },
        paint: { "text-color": "#145b44" },
      });
      m.addLayer({
        id: "station-dot",
        type: "circle",
        source: "stations",
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, 3, 10, 8],
          "circle-color": "#18664f",
          "circle-stroke-color": "#ffffff",
          "circle-stroke-width": 2,
          "circle-opacity": ["step", ["zoom"], 1, 10, 0],
        },
      });
      m.on("click", "cluster-halo", (e) => {
        const f = e.features?.[0];
        if (!f) return;
        const src = m.getSource("stations") as maplibregl.GeoJSONSource;
        src
          .getClusterExpansionZoom(f.properties!.cluster_id)
          .then((z) =>
            m.easeTo({
              center: (f.geometry as GeoJSON.Point).coordinates as [
                number,
                number,
              ],
              zoom: z + 0.3,
              duration: NO_MOTION.matches ? 0 : 500,
            }),
          );
      });
      m.on("click", "station-dot", (e) => {
        const id = e.features?.[0]?.properties?.id;
        if (id) selectRef.current(id);
      });
      m.on("mouseenter", "cluster-halo", () => {
        m.getCanvas().style.cursor = "pointer";
      });
      m.on("mouseleave", "cluster-halo", () => {
        m.getCanvas().style.cursor = "";
      });
      m.on("mouseenter", "station-dot", () => {
        m.getCanvas().style.cursor = "pointer";
      });
      m.on("mouseleave", "station-dot", () => {
        m.getCanvas().style.cursor = "";
      });
    });
    return () => {
      removeTimers.current.forEach(clearTimeout);
      markers.current.forEach((x) => x.remove());
      markers.current.clear();
      m.remove();
      map.current = null;
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const update = () => {
      if (!m.isStyleLoaded()) return;
      const source = m.getSource("stations") as
        maplibregl.GeoJSONSource | undefined;
      source?.setData({
        type: "FeatureCollection",
        features: stations.map((s) => ({
          type: "Feature",
          properties: { id: s.id },
          geometry: { type: "Point", coordinates: s.coordinates },
        })),
      });
    };
    if (m.isStyleLoaded()) update();
    else m.once("load", update);
  }, [stations]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      if (terrain && !m.getSource("terrain")) {
        try {
          m.addSource("terrain", {
            type: "raster-dem",
            tiles: [DEM],
            encoding: "terrarium",
            tileSize: 512,
            maxzoom: 12,
          });
          m.setTerrain({ source: "terrain", exaggeration: 1 });
          setTerrainError(false);
        } catch {
          setTerrainError(true);
        }
      } else if (terrain && m.getSource("terrain")) {
        try {
          m.setTerrain({ source: "terrain", exaggeration: 1 });
        } catch {
          setTerrainError(true);
        }
      } else if (!terrain) m.setTerrain(null);
    };
    if (m.isStyleLoaded()) apply();
    else m.once("load", apply);
    return () => {
      m.off("load", apply);
    };
  }, [terrain, stations]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const current = stationsRef.current;
        const wanted = new Set<string>();
        const zoom = m.getZoom();
        if (zoom >= 9.7) {
          const width = m.getContainer().clientWidth,
            height = m.getContainer().clientHeight;
          const pitchFactor = Math.sin((m.getPitch() * Math.PI) / 180);
          // On a pitched ground plane, lower screen positions are nearer the camera.
          // At a flat pitch every stamp keeps the same scale.
          const depthAt = (y: number) =>
            Math.max(
              0.58,
              Math.min(1.45, 1 + (y / height - 0.5) * pitchFactor * 1.35),
            );
          const baseSize = (BASE_STAMP_SIZE * scaleRef.current) / 100;
          const candidates = current
            .map((s) => {
              const p = m.project(s.coordinates);
              return { s, p, depth: depthAt(p.y) };
            })
            .filter(
              (x) =>
                x.p.x > -180 &&
                x.p.x < width + 180 &&
                x.p.y > -180 &&
                x.p.y < height + 180,
            );
          candidates.sort(
            (a, b) => b.depth - a.depth || a.s.id.localeCompare(b.s.id),
          );
          const chosen: { x: number; y: number; visualSize: number }[] = [];
          for (const { s, p, depth } of candidates) {
            // Preload near the viewport. Decode only thumbnails likely to enter soon.
            if (
              p.x > -100 &&
              p.x < width + 100 &&
              p.y > -100 &&
              p.y < height + 100 &&
              !preloaded.current.has(s.id)
            ) {
              const img = new Image();
              img.src = s.stamps[0].thumbnail;
              preloaded.current.add(s.id);
            }
            const visualSize = baseSize * depth;
            if (
              p.x < 0 ||
              p.x > width ||
              p.y < 0 ||
              p.y > height ||
              chosen.some((c) => {
                const gap = (c.visualSize + visualSize) / 2 + 19;
                return Math.abs(c.x - p.x) < gap && Math.abs(c.y - p.y) < gap;
              }) ||
              chosen.length >= 65
            )
              continue;
            chosen.push({ x: p.x, y: p.y, visualSize });
            wanted.add(s.id);
            if (removeTimers.current.has(s.id)) {
              clearTimeout(removeTimers.current.get(s.id));
              removeTimers.current.delete(s.id);
            }
            let marker = markers.current.get(s.id);
            if (!marker) {
              const el = document.createElement("button");
              el.type = "button";
              el.className = "stamp-pin";
              el.setAttribute(
                "aria-label",
                `Open ${s.name}, ${s.stamps.length} designs`,
              );
              el.style.setProperty("--stamp-size", `${baseSize}px`);
              const image = document.createElement("img");
              image.src = s.stamps[0].thumbnail;
              image.alt = "";
              image.loading = "eager";
              image.onerror = () => {
                image.onerror = null;
                image.src = "/icon.svg";
              };
              const card = document.createElement("span");
              card.className = "pin-art";
              card.append(image);
              const count = document.createElement("span");
              count.className = "pin-count";
              count.textContent =
                s.stamps.length > 1 ? `${s.stamps.length}` : "";
              const stem = document.createElement("span");
              stem.className = "pin-stem";
              // const foot = document.createElement("span");
              // foot.className = "pin-foot";
              const label = document.createElement("span");
              label.className = "pin-label";
              label.textContent = s.name;
              const body = document.createElement("span");
              body.className = "pin-body";
              body.append(card, count, stem, label);
              el.append(body);
              el.addEventListener("click", (ev) => {
                ev.stopPropagation();
                selectRef.current(s.id);
              });
              marker = new maplibregl.Marker({
                element: el,
                anchor: "bottom",
                pitchAlignment: "viewport",
              })
                .setLngLat(s.coordinates)
                .addTo(m);
              markers.current.set(s.id, marker);
              requestAnimationFrame(() => el.classList.add("pin-visible"));
            } else {
              marker.setLngLat(s.coordinates);
              marker.getElement().classList.add("pin-visible");
              marker.getElement().classList.remove("pin-leaving");
            }
            const el = marker.getElement();
            el.style.setProperty("--stamp-size", `${baseSize}px`);
            el.style.setProperty("--depth-scale", depth.toFixed(3));
            el.style.setProperty("--entry-scale", (depth * 0.86).toFixed(3));
            el.style.setProperty("--exit-scale", (depth * 0.87).toFixed(3));
            el.style.zIndex = String(Math.round(depth * 1000));
          }
        }
        markers.current.forEach((marker, id) => {
          if (wanted.has(id) || removeTimers.current.has(id)) return;
          marker.getElement().classList.remove("pin-visible");
          marker.getElement().classList.add("pin-leaving");
          const delay = NO_MOTION.matches ? 0 : 230;
          removeTimers.current.set(
            id,
            window.setTimeout(() => {
              marker.remove();
              markers.current.delete(id);
              removeTimers.current.delete(id);
            }, delay),
          );
        });
      });
    };
    m.on("move", update);
    m.on("zoom", update);
    m.on("resize", update);
    update();
    return () => {
      m.off("move", update);
      m.off("zoom", update);
      m.off("resize", update);
      cancelAnimationFrame(frame);
    };
  }, [stations, scale]);

  useEffect(() => {
    const m = map.current;
    if (m && focus)
      m.flyTo({
        center: focus.coordinates,
        zoom: Math.max(m.getZoom(), 12),
        pitch: 55,
        duration: NO_MOTION.matches ? 0 : 700,
        essential: true,
      });
  }, [focus]);
  return (
    <div className="map-wrap">
      <div className="map-canvas" ref={container} />
      <div className="map-hints">
        <span>
          <Layers3 size={14} /> Drag to explore · right drag to tilt
        </span>
        {terrainError && (
          <span className="map-warning">
            Terrain unavailable · flat map active
          </span>
        )}
        {mapError && (
          <span className="map-warning">
            Map tiles unavailable · saved stamps remain accessible
          </span>
        )}
      </div>
      <div className="map-credit">
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
        >
          © OpenStreetMap
        </a>{" "}
        ·{" "}
        <a
          href="https://mapterhorn.com/attribution/"
          target="_blank"
          rel="noreferrer"
        >
          © Mapterhorn
        </a>
      </div>
    </div>
  );
}

export default function App() {
  const [stamps, setStamps] = useState<Stamp[]>([]);
  const [logos, setLogos] = useState<Record<string, Logo>>({});
  const [state, setState] = useState<StoreState | null>(null);
  const [tab, setTab] = useState("explore");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Stamp | null>(null);
  const [focus, setFocus] = useState<Station | null>(null);
  const [activeBook, setActiveBook] = useState(DEFAULT_BOOK);
  const [notice, setNotice] = useState("");
  const [download, setDownload] = useState({
    running: false,
    done: 0,
    total: 0,
    error: "",
  });
  const cancelDownload = useRef(false);
  const downloadJob = useRef<Promise<void> | null>(null);
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const inputRef = useRef<HTMLInputElement>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [bookDialog, setBookDialog] = useState<
    "create" | "rename" | "delete" | null
  >(null);
  const [bookName, setBookName] = useState("");
  useEffect(() => {
    Promise.all([
      fetch("/data/stamps.json").then((r) => r.json()),
      fetch("/data/logos.json").then((r) => r.json()),
      readState(),
    ])
      .then(([a, b, c]) => {
        setStamps(a);
        setLogos(b);
        setState(c);
      })
      .catch((e) =>
        setNotice(`Could not load the local catalog: ${e.message}`),
      );
  }, []);
  const stations = useMemo(() => makeStations(stamps), [stamps]);
  const stationByStamp = useMemo(() => {
    const m = new Map<string, Station>();
    for (const s of stations) for (const x of s.stamps) m.set(x.id, s);
    return m;
  }, [stations]);
  const unplaced = useMemo(
    () => stamps.filter((s) => !s.coordinates),
    [stamps],
  );
  const match = useMemo(
    () =>
      query.trim()
        ? stamps
            .filter((s) =>
              (s.name + " " + s.operator + " " + (s.lines || []).join(" "))
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .slice(0, 50)
        : [],
    [query, stamps],
  );
  const savedIds = new Set(Object.values(state?.entries || {}).flat());
  const updateState = useCallback(
    (f: (s: StoreState) => StoreState) =>
      setState((old) => {
        if (!old) return old;
        const next = f(old);
        saveQueue.current = saveQueue.current
          .catch(() => {})
          .then(() => writeState(next));
        saveQueue.current.catch((e) =>
          setNotice("Local save failed: " + e.message),
        );
        return next;
      }),
    [],
  );
  const choose = (stamp: Stamp) => {
    setSelected(stamp);
    setMobileOpen(false);
    const station = stationByStamp.get(stamp.id);
    if (station) {
      setFocus(station);
      setTab("explore");
    }
  };
  const toggleSaved = async (stamp: Stamp, bookId: string) => {
    if (!state) return;
    const has = (state.entries[bookId] || []).includes(stamp.id);
    updateState((s) => ({
      ...s,
      entries: {
        ...s.entries,
        [bookId]: has
          ? (s.entries[bookId] || []).filter((id) => id !== stamp.id)
          : [...(s.entries[bookId] || []), stamp.id],
      },
    }));
    try {
      if (!has) {
        await Promise.all([
          cacheSavedImage(stamp.image),
          cacheSavedImage(stamp.thumbnail),
        ]);
        await requestPersistence();
      } else if (
        !Object.entries(state.entries).some(
          ([id, entries]) => id !== bookId && entries.includes(stamp.id),
        )
      )
        await Promise.all([
          removeSavedImage(stamp.image),
          removeSavedImage(stamp.thumbnail),
        ]);
    } catch (e) {
      setNotice(
        `Artwork could not be cached for offline use: ${(e as Error).message}`,
      );
    }
  };
  const openBookDialog = (mode: "create" | "rename" | "delete") => {
    setBookName(
      mode === "create"
        ? ""
        : state?.books.find((b) => b.id === activeBook)?.name || "",
    );
    setBookDialog(mode);
  };
  const submitBookDialog = () => {
    if (bookDialog === "create" && bookName.trim()) {
      const id = crypto.randomUUID();
      updateState((s) => ({
        ...s,
        books: [
          ...s.books,
          { id, name: bookName.trim(), createdAt: new Date().toISOString() },
        ],
        entries: { ...s.entries, [id]: [] },
      }));
      setActiveBook(id);
      setTab("books");
    } else if (
      bookDialog === "rename" &&
      bookName.trim() &&
      activeBook !== DEFAULT_BOOK
    )
      updateState((s) => ({
        ...s,
        books: s.books.map((b) =>
          b.id === activeBook ? { ...b, name: bookName.trim() } : b,
        ),
      }));
    else if (bookDialog === "delete" && activeBook !== DEFAULT_BOOK) {
      updateState((s) => {
        const entries = { ...s.entries };
        delete entries[activeBook];
        return {
          ...s,
          books: s.books.filter((b) => b.id !== activeBook),
          entries,
        };
      });
      setActiveBook(DEFAULT_BOOK);
    }
    setBookDialog(null);
  };
  const exportBackup = () => {
    if (!state) return;
    const blob = new Blob(
      [
        JSON.stringify(
          {
            format: "ekitag-atlas-backup",
            version: 1,
            exportedAt: new Date().toISOString(),
            ...state,
          },
          null,
          2,
        ),
      ],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ekitag-stamp-books-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const importBackup = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text());
      const next = validateBackup(raw, new Set(stamps.map((x) => x.id)));
      await saveQueue.current.catch(() => {});
      await writeState(next);
      setState(next);
      for (const id of new Set(Object.values(next.entries).flat())) {
        const stamp = stamps.find((s) => s.id === id);
        if (stamp) {
          cacheSavedImage(stamp.image).catch(() => {});
          cacheSavedImage(stamp.thumbnail).catch(() => {});
        }
      }
      setNotice(
        "Backup imported. Saved artwork is being prepared for offline use.",
      );
    } catch (e) {
      setNotice(`Import failed: ${(e as Error).message}`);
    }
  };
  const fullDownload = () => {
    if (downloadJob.current) return;
    cancelDownload.current = false;
    const run = async () => {
      const cache = await caches.open("all-art-v1");
      let done = 0;
      for (const stamp of stamps)
        if (
          (await cache.match(stamp.image)) &&
          (await cache.match(stamp.thumbnail))
        )
          done++;
      setDownload({ running: true, done, total: stamps.length, error: "" });
      for (const stamp of stamps) {
        if (cancelDownload.current) break;
        try {
          if (!(await cache.match(stamp.image))) await cache.add(stamp.image);
          if (cancelDownload.current) break;
          if (!(await cache.match(stamp.thumbnail)))
            await cache.add(stamp.thumbnail);
          done++;
          setDownload({ running: true, done, total: stamps.length, error: "" });
        } catch (e) {
          setDownload({
            running: false,
            done,
            total: stamps.length,
            error: `Stopped: ${(e as Error).message}. Retry to resume.`,
          });
          return;
        }
      }
      setDownload({ running: false, done, total: stamps.length, error: "" });
    };
    downloadJob.current = run().finally(() => {
      downloadJob.current = null;
    });
  };
  const removeFullDownload = async () => {
    cancelDownload.current = true;
    if (downloadJob.current) await downloadJob.current;
    await caches.delete("all-art-v1");
    setDownload({ running: false, done: 0, total: stamps.length, error: "" });
    setNotice(
      "Full-library download removed. Artwork saved in books remains offline.",
    );
  };
  const selectedStation = selected
    ? stationByStamp.get(selected.id)
    : undefined;
  const bookStamps = stamps.filter((s) =>
    (state?.entries[activeBook] || []).includes(s.id),
  );
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? "mobile-open" : ""}`}>
        <div className="brand">
          <img src="/logo.png" alt="EKITAG ATLAS" height="50" />
          <IconButton
            className="mobile-close"
            variant="ghost"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </IconButton>
        </div>
        <div className="sidebar-top">
          <TextField.Root
            placeholder="Search stations or operators"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          >
            <TextField.Slot>
              <Search size={16} />
            </TextField.Slot>
          </TextField.Root>
        </div>
        <Tabs.Root value={tab} onValueChange={setTab} className="app-tabs">
          <Tabs.List>
            <Tabs.Trigger value="explore">
              <Compass size={16} /> Explore
            </Tabs.Trigger>
            <Tabs.Trigger value="books">
              <BookOpen size={16} /> Books
            </Tabs.Trigger>
            <Tabs.Trigger value="unplaced">
              <MapPin size={16} /> Unplaced
            </Tabs.Trigger>
          </Tabs.List>
        </Tabs.Root>
        <ScrollArea className="sidebar-scroll">
          <div className="sidebar-content">
            {query.trim() ? (
              <>
                <div className="section-eyebrow">
                  Search results · {match.length}
                </div>
                {match.length ? (
                  match.map((s) => (
                    <button
                      className="result-row"
                      key={s.id}
                      onClick={() => choose(s)}
                    >
                      <img
                        src={s.thumbnail}
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src = "/icon.svg";
                        }}
                        alt=""
                        loading="lazy"
                      />
                      <span>
                        <strong>{s.name}</strong>
                        <small>
                          {s.operator}
                          {!s.coordinates ? " · Unplaced" : ""}
                        </small>
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="empty-copy">
                    No matching designs in this archive.
                  </p>
                )}
              </>
            ) : tab === "explore" ? (
              <>
                <div className="stat-grid">
                  <Card>
                    <strong>{stations.length.toLocaleString()}</strong>
                    <small>mapped stations</small>
                  </Card>
                  <Card>
                    <strong>{savedIds.size}</strong>
                    <small>saved designs</small>
                  </Card>
                </div>
                <div className="section-eyebrow">RECENTLY ADDED</div>
                {stamps
                  .filter((s) => s.coordinates)
                  .slice(-9)
                  .reverse()
                  .map((s) => (
                    <button
                      className="result-row"
                      key={s.id}
                      onClick={() => choose(s)}
                    >
                      <img
                        src={s.thumbnail}
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src = "/icon.svg";
                        }}
                        alt=""
                        loading="lazy"
                      />
                      <span>
                        <strong>{s.name}</strong>
                        <small>{s.operator}</small>
                      </span>
                    </button>
                  ))}
              </>
            ) : tab === "books" ? (
              <>
                <div className="list-heading">
                  <div>
                    <div className="section-eyebrow">YOUR COLLECTIONS</div>
                    <Heading size="5">Stamp books</Heading>
                  </div>
                  <IconButton
                    variant="soft"
                    onClick={() => openBookDialog("create")}
                    aria-label="Create collection"
                  >
                    <Plus size={18} />
                  </IconButton>
                </div>
                <Select.Root value={activeBook} onValueChange={setActiveBook}>
                  <Select.Trigger className="book-select" />
                  <Select.Content>
                    {state?.books.map((b) => (
                      <Select.Item key={b.id} value={b.id}>
                        {b.name}
                      </Select.Item>
                    ))}
                  </Select.Content>
                </Select.Root>
                <div className="book-actions">
                  {activeBook !== DEFAULT_BOOK && (
                    <>
                      <Button
                        variant="ghost"
                        size="1"
                        onClick={() => openBookDialog("rename")}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="ghost"
                        color="red"
                        size="1"
                        onClick={() => openBookDialog("delete")}
                      >
                        Delete
                      </Button>
                    </>
                  )}
                  <Text size="1" color="gray">
                    {bookStamps.length} designs
                  </Text>
                </div>
                {bookStamps.length ? (
                  bookStamps.map((s) => (
                    <button
                      className="result-row"
                      key={s.id}
                      onClick={() => choose(s)}
                    >
                      <img
                        src={s.thumbnail}
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src = "/icon.svg";
                        }}
                        alt=""
                        loading="lazy"
                      />
                      <span>
                        <strong>{s.name}</strong>
                        <small>{s.operator}</small>
                      </span>
                      <Check size={15} color="#2d8664" />
                    </button>
                  ))
                ) : (
                  <div className="empty-state">
                    <BookOpen size={28} />
                    <strong>This book is empty</strong>
                    <Text size="2" color="gray">
                      Open a stamp and save it here.
                    </Text>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="section-eyebrow">
                  NO VERIFIED RAILWAY COORDINATE
                </div>
                <Heading size="5">Unplaced designs</Heading>
                <Text size="2" color="gray">
                  Includes train and facility designs plus station names
                  requiring further verification.
                </Text>
                <div className="unplaced-summary">
                  {unplaced.filter((s) => s.section !== "station").length} train
                  or facility ·{" "}
                  {unplaced.filter((s) => s.section === "station").length}{" "}
                  station names
                </div>
                {unplaced.map((s) => (
                  <button
                    className="result-row"
                    key={s.id}
                    onClick={() => choose(s)}
                  >
                    <img
                      src={s.thumbnail}
                      onError={(e) => {
                        e.currentTarget.onerror = null;
                        e.currentTarget.src = "/icon.svg";
                      }}
                      alt=""
                      loading="lazy"
                    />
                    <span>
                      <strong>{s.name}</strong>
                      <small>{s.unplacedReason}</small>
                    </span>
                  </button>
                ))}
              </>
            )}
          </div>
        </ScrollArea>
        <div className="sidebar-footer">
          Stamp Images provided by the Ekitag ATWiki{" "}
          <a
            href="https://w.atwiki.jp/ekitag/pages/13.html"
            target="_blank"
            rel="noreferrer"
          >
            Artwork source ↗
          </a>
        </div>
      </aside>
      <main className="map-panel">
        <div className="mobile-bar">
          <IconButton
            variant="soft"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </IconButton>
          <strong>EKITAG ATLAS</strong>
        </div>
        <MapView
          stations={stations}
          scale={state?.stampScale || 100}
          terrain={state?.terrain === true}
          onSelect={(id) => {
            const s = stations.find((x) => x.id === id)?.stamps[0];
            if (s) setSelected(s);
          }}
          focus={focus}
        />
        <div className="map-toolbar">
          <div className="toolbar-heading">
            <span>
              <Settings2 size={17} /> Map display
            </span>
          </div>
          <div className="slider-row">
            <span>Stamp size</span>
            <strong>{state?.stampScale || 100}%</strong>
          </div>
          <Slider
            min={50}
            max={200}
            step={5}
            value={[state?.stampScale || 100]}
            onValueChange={([n]) =>
              updateState((s) => ({ ...s, stampScale: n }))
            }
            aria-label="Map stamp size"
          />
          <div className="size-note">
            Closer stamps appear larger and in front. Higher percentages show
            fewer pins.
          </div>
          <Separator size="4" />
          <div className="terrain-row">
            <span>3D terrain</span>
            <Switch
              checked={state?.terrain === true}
              onCheckedChange={(v) =>
                updateState((s) => ({ ...s, terrain: v }))
              }
            />
          </div>
        </div>
        <Dialog.Root>
          <Dialog.Trigger>
            <button className="library-trigger">
              <Download size={17} /> Offline library
            </button>
          </Dialog.Trigger>
          <Dialog.Content maxWidth="500px">
            <Dialog.Title>Offline artwork</Dialog.Title>
            <Dialog.Description size="2">
              Saved stamps are cached automatically. Download the full archive
              only if you want every design available offline.
            </Dialog.Description>
            <div className="download-meta">
              <span>{stamps.length.toLocaleString()} designs</span>
              <strong>
                About{" "}
                {bytes(
                  stamps.reduce(
                    (n, s) => n + s.imageBytes + s.thumbnailBytes,
                    0,
                  ),
                )}
              </strong>
            </div>
            {download.running || download.done > 0 ? (
              <div className="progress-block">
                <div className="progress-track">
                  <div
                    style={{
                      width: `${download.total ? (100 * download.done) / download.total : 0}%`,
                    }}
                  />
                </div>
                <Text size="2">
                  {download.done} / {download.total} cached
                </Text>
              </div>
            ) : null}
            {download.error && (
              <Text color="red" size="2">
                {download.error}
              </Text>
            )}
            <Flex gap="2" wrap="wrap" mt="4">
              <Button onClick={fullDownload} disabled={download.running}>
                {download.done
                  ? "Resume / check download"
                  : "Download all stamps"}
              </Button>
              {download.running && (
                <Button
                  variant="soft"
                  onClick={() => {
                    cancelDownload.current = true;
                  }}
                >
                  Pause
                </Button>
              )}
              <Button variant="soft" color="red" onClick={removeFullDownload}>
                Remove full download
              </Button>
            </Flex>
            <Separator size="4" my="4" />
            <Heading size="3">Backup collections</Heading>
            <Text size="2" color="gray">
              Books, entries, and display settings stay in this browser. Export
              a JSON backup before clearing browser data.
            </Text>
            <Flex gap="2" mt="3">
              <Button variant="soft" onClick={exportBackup}>
                <Download size={15} /> Export JSON
              </Button>
              <Button variant="soft" onClick={() => inputRef.current?.click()}>
                <Upload size={15} /> Import JSON
              </Button>
            </Flex>
            <input
              ref={inputRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) importBackup(f);
                e.target.value = "";
              }}
            />
          </Dialog.Content>
        </Dialog.Root>
        {selected && (
          <div className="detail-panel">
            <button
              className="detail-close"
              onClick={() => setSelected(null)}
              aria-label="Close stamp details"
            >
              <X size={18} />
            </button>
            <div className="detail-heading">
              <div>
                <Heading size="5">{selected.stationName}</Heading>
                <LogoBadge operator={selected.operator} logos={logos} />
              </div>
              {selectedStation && (
                <Badge color="jade" variant="soft">
                  {selectedStation.stamps.length} design
                  {selectedStation.stamps.length > 1 ? "s" : ""}
                </Badge>
              )}
            </div>
            <div className="detail-scroll">
              <img
                className="detail-image"
                src={selected.image}
                alt={`${selected.name} stamp artwork`}
              />
              {selectedStation && selectedStation.stamps.length > 1 && (
                <div className="design-strip">
                  {selectedStation.stamps.map((s) => (
                    <button
                      key={s.id}
                      onClick={() => setSelected(s)}
                      className={s.id === selected.id ? "active" : ""}
                    >
                      <img
                        src={s.thumbnail}
                        onError={(e) => {
                          e.currentTarget.onerror = null;
                          e.currentTarget.src = "/icon.svg";
                        }}
                        alt={`${s.name} design`}
                      />
                    </button>
                  ))}
                </div>
              )}
              <div className="detail-meta">
                <strong>{selected.name}</strong>
                <small>{selected.operator}</small>
                {selected.lines && <small>{selected.lines.join(" · ")}</small>}
                {selected.unplacedReason && (
                  <small>{selected.unplacedReason}</small>
                )}
              </div>
              <div className="save-heading">Save to collection</div>
              <div className="save-list">
                {state?.books.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => toggleSaved(selected, b.id)}
                    className={
                      (state.entries[b.id] || []).includes(selected.id)
                        ? "is-saved"
                        : ""
                    }
                  >
                    <span>{b.name}</span>
                    {(state.entries[b.id] || []).includes(selected.id) ? (
                      <Check size={17} />
                    ) : (
                      <Plus size={17} />
                    )}
                  </button>
                ))}
                <button onClick={() => openBookDialog("create")}>
                  <span>Create collection</span>
                  <Plus size={17} />
                </button>
              </div>
              <div className="detail-sources">
                <Text size="1" color="gray">
                  Pin: {selected.coordinateSource || "No verified coordinate"}.{" "}
                  {selected.matchNote || ""}
                </Text>
                <a href={selected.sourcePage} target="_blank" rel="noreferrer">
                  View artwork source ↗
                </a>
              </div>
            </div>
          </div>
        )}
        <Dialog.Root
          open={bookDialog !== null}
          onOpenChange={(open) => {
            if (!open) setBookDialog(null);
          }}
        >
          <Dialog.Content maxWidth="380px">
            <Dialog.Title>
              {bookDialog === "create"
                ? "Create collection"
                : bookDialog === "rename"
                  ? "Rename collection"
                  : "Delete collection"}
            </Dialog.Title>
            {bookDialog === "delete" ? (
              <Dialog.Description size="2">
                Delete “{bookName}”? Stamps saved in other books will stay
                there.
              </Dialog.Description>
            ) : (
              <>
                <Dialog.Description size="2">
                  Give this stamp collection a name.
                </Dialog.Description>
                <TextField.Root
                  mt="4"
                  autoFocus
                  value={bookName}
                  onChange={(e) => setBookName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitBookDialog();
                  }}
                  placeholder="Collection name"
                  aria-label="Collection name"
                />
              </>
            )}
            <Flex justify="end" gap="2" mt="5">
              <Button
                variant="soft"
                color="gray"
                onClick={() => setBookDialog(null)}
              >
                Cancel
              </Button>
              <Button
                color={bookDialog === "delete" ? "red" : "jade"}
                disabled={bookDialog !== "delete" && !bookName.trim()}
                onClick={submitBookDialog}
              >
                {bookDialog === "delete"
                  ? "Delete"
                  : bookDialog === "rename"
                    ? "Save name"
                    : "Create"}
              </Button>
            </Flex>
          </Dialog.Content>
        </Dialog.Root>
        {notice && (
          <div className="notice">
            <span>{notice}</span>
            <button onClick={() => setNotice("")}>
              <X size={16} />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
