import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiX } from "react-icons/fi";
import { displayName, type GameEntity } from "./gameData";
import { t, useI18n } from "./i18n";
import { inputCls } from "./ui";

/**
 * Searchable combobox over a Pal/item catalog: type a name, see icons, pick
 * one to fill its id. Free text still works for entities not in the catalog
 * (new IDs after a game update), so the field never blocks a valid command.
 */
export function EntityPicker({
  catalog,
  iconUrl,
  value,
  onChange,
  placeholder,
}: {
  catalog: GameEntity[];
  iconUrl: (icon: string) => string;
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  // 下拉用 portal 掛到 body(fixed 定位),避免被外層 modal 的 overflow 裁掉。
  const menuRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const selected = catalog.find((e) => e.id === value);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? catalog.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.id.toLowerCase().includes(q) ||
            e.zh?.includes(query.trim()),
        )
      : catalog;
    return list.slice(0, 60);
  }, [catalog, query]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (boxRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);

  // 開啟時量錨點位置,並在捲動/縮放時跟著更新(scroll 用 capture 抓到任何祖先的捲動)。
  useEffect(() => {
    if (!open) return;
    const update = () => boxRef.current && setRect(boxRef.current.getBoundingClientRect());
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [open, matches.length]);

  const pick = (entity: GameEntity) => {
    onChange(entity.id);
    setQuery("");
    setOpen(false);
  };

  // A value not in the catalog (raw id) is shown as-is in the text field.
  if (value && !open) {
    return (
      <div className={`${inputCls} flex min-w-0 items-center gap-2`}>
        {selected?.icon ? (
          <img src={iconUrl(selected.icon)} alt="" className="size-6 shrink-0" />
        ) : (
          <span className="size-6 shrink-0 rounded bg-card-soft" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            <>
              {displayName(selected)}
              <span className="ml-2 font-mono text-xs text-ink-muted">{value}</span>
            </>
          ) : (
            <span className="font-mono">{value}</span>
          )}
        </span>
        <button
          type="button"
          className="shrink-0 text-ink-muted transition hover:text-berry"
          onClick={() => {
            onChange("");
            setOpen(true);
          }}
          aria-label={t("清除")}
        >
          <FiX className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={boxRef}>
      <input
        className={inputCls + " w-full"}
        value={query}
        placeholder={placeholder ?? t("搜尋名稱或直接輸入 ID…")}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
          setHighlight(0);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setHighlight((h) => Math.min(h + 1, matches.length - 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
          else if (e.key === "Enter" && matches[highlight]) { e.preventDefault(); pick(matches[highlight]); }
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {/* Allow committing whatever was typed as a raw id. */}
      {query.trim() && (
        <button
          type="button"
          className="absolute top-1/2 right-2 -translate-y-1/2 text-xs font-bold text-pal"
          onClick={() => pick({ id: query.trim(), name: query.trim() })}
        >
          {t("用此 ID")}
        </button>
      )}
      {open && matches.length > 0 && rect &&
        createPortal(
          (() => {
            const spaceBelow = window.innerHeight - rect.bottom;
            const openUp = spaceBelow < 300 && rect.top > spaceBelow;
            const style: React.CSSProperties = openUp
              ? { left: rect.left, bottom: window.innerHeight - rect.top + 4, width: rect.width, maxHeight: Math.min(288, rect.top - 12) }
              : { left: rect.left, top: rect.bottom + 4, width: rect.width, maxHeight: Math.min(288, spaceBelow - 12) };
            return (
              <div
                ref={menuRef}
                style={style}
                className="fixed z-60 overflow-y-auto rounded-xl border-2 border-line bg-card shadow-(--shadow-cute)"
              >
                {matches.map((entity, i) => (
            <button
              key={entity.id}
              type="button"
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition ${i === highlight ? "bg-card-soft" : "hover:bg-card-soft"}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => pick(entity)}
            >
              {entity.icon ? (
                <img src={iconUrl(entity.icon)} alt="" className="size-7 shrink-0" />
              ) : (
                <span className="size-7 shrink-0 rounded bg-card-soft" />
              )}
              <span className="min-w-0 flex-1 truncate text-sm font-bold">
                {displayName(entity)}
                {entity.zh && <span className="ml-1.5 text-xs font-normal text-ink-muted">{entity.name}</span>}
              </span>
              <span className="max-w-[45%] shrink-0 truncate font-mono text-xs text-ink-muted">{entity.id}</span>
            </button>
                ))}
              </div>
            );
          })(),
          document.body,
        )}
    </div>
  );
}
