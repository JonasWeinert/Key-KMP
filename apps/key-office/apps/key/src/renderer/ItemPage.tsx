// Every item opens as the same kind of page, like a Notion page: a bar with the item's own
// actions (Read for a PDF, Open file for a file ...), an optional cover and icon, the title,
// a block of properties, then the item's editor and parts. Notes, sources and workspace
// pages all render through `ItemPage`; each passes its own bar, title and body.
import { useEffect, useRef, useState, type HTMLAttributes, type ReactNode, type Ref } from "react";
import type { Creator } from "./citation";
import { Icon, type IconName } from "./icons";
import type { PropertyDefinition } from "./PropertySheets";
import { Creators, DEFAULT_FIELDS, FIELDS, FieldRow, MORE_FIELDS, TypedProperties, type FieldSpec } from "./SourceInspector";
import { COVER_COLORS, COVER_GRADIENTS, PAGE_ICONS, coverBackground, type PageAppearance } from "./page-appearance";
import "./item-page.css";

export type ItemKind = "note" | "source" | "record";

/** Saves a cover image and turns a stored path back into a URL (the notes' media host). */
export interface PageMedia {
  save?: (file: File) => Promise<string>;
  url: (src: string) => string;
}

/** A patch to the appearance: a key set to null is removed. */
export type AppearancePatch = { icon?: string | null; cover?: PageAppearance["cover"] | null };

export function ItemPage({
  kind,
  className,
  innerClassName,
  innerProps,
  pageRef,
  appearance,
  onAppearance,
  media,
  defaultIcon,
  bar,
  title,
  children,
  ...rest
}: {
  kind: ItemKind;
  className: string;
  innerClassName: string;
  innerProps?: HTMLAttributes<HTMLDivElement> & Record<`data-${string}`, unknown>;
  pageRef?: Ref<HTMLElement>;
  appearance: PageAppearance;
  /** Without it the header is read-only. */
  onAppearance?: (patch: AppearancePatch) => void;
  media?: PageMedia;
  /** Shown in the icon picker as the item's default look. */
  defaultIcon: IconName;
  bar: ReactNode;
  title: ReactNode;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLElement>, "title">) {
  const background = coverBackground(appearance.cover, media?.url);
  return (
    <article ref={pageRef} className={`kx-item-page ${className}`} data-kind={kind} data-cover={!!appearance.cover} data-icon={!!appearance.icon} {...rest}>
      <div className={`${innerClassName} kx-item-page-toprow`}>{bar}</div>
      {background && <PageCover background={background} appearance={appearance} onAppearance={onAppearance} media={media} />}
      <div className={`${innerClassName} kx-item-page-body`} {...innerProps}>
        <PageHeading appearance={appearance} onAppearance={onAppearance} media={media} defaultIcon={defaultIcon} />
        {title}
        {children}
      </div>
    </article>
  );
}

/** A popover that closes on an outside click or Escape. */
function Popover({ onClose, className, children }: { onClose: () => void; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    // Opened by a click: listen from the next one on.
    const timer = setTimeout(() => document.addEventListener("mousedown", down));
    document.addEventListener("keydown", key);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  return (
    <div ref={ref} className={`kx-page-popover ${className ?? ""}`} role="dialog">
      {children}
    </div>
  );
}

function PageCover({ background, appearance, onAppearance, media }: { background: string; appearance: PageAppearance; onAppearance?: (p: AppearancePatch) => void; media?: PageMedia }) {
  const [picking, setPicking] = useState(false);
  return (
    <div className="kx-page-cover" style={{ background }} role="img" aria-label="Page cover">
      {onAppearance && (
        <div className="kx-page-cover-actions">
          <button onClick={() => setPicking(true)}>Change cover</button>
          {appearance.cover?.kind === "image" && (
            <button
              title="Move the image up or down"
              onClick={() => {
                const cover = appearance.cover!;
                const position = (((cover.kind === "image" ? cover.position : 50) ?? 50) + 25) % 125;
                onAppearance({ cover: { ...cover, kind: "image", position } });
              }}
            >
              Reposition
            </button>
          )}
          <button onClick={() => onAppearance({ cover: null })}>Remove</button>
        </div>
      )}
      {picking && onAppearance && <CoverPicker media={media} onPick={(cover) => onAppearance({ cover })} onClose={() => setPicking(false)} />}
    </div>
  );
}

function CoverPicker({ media, onPick, onClose }: { media?: PageMedia; onPick: (c: NonNullable<PageAppearance["cover"]>) => void; onClose: () => void }) {
  const [link, setLink] = useState("");
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  return (
    <Popover onClose={onClose} className="kx-cover-picker">
      <h4>Colour</h4>
      <div className="kx-cover-swatches">
        {COVER_COLORS.map(([name, value]) => (
          <button key={name} title={name} aria-label={`${name} cover`} style={{ background: value }} onClick={() => onPick({ kind: "color", value })} />
        ))}
      </div>
      <h4>Gradient</h4>
      <div className="kx-cover-swatches">
        {COVER_GRADIENTS.map(([name, value]) => (
          <button key={name} title={name} aria-label={`${name} cover`} style={{ background: value }} onClick={() => onPick({ kind: "gradient", value })} />
        ))}
      </div>
      <h4>Image</h4>
      <div className="kx-cover-image-row">
        {media?.save && (
          <>
            <button className="kx-page-action" onClick={() => file.current?.click()}>
              <Icon name="image" size={12} /> Upload…
            </button>
            <input
              ref={file}
              type="file"
              accept="image/*"
              hidden
              aria-label="Cover image file"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                if (!picked) return;
                setError("");
                void media.save!(picked)
                  .then((value) => onPick({ kind: "image", value }))
                  .catch((reason) => setError(String(reason)));
              }}
            />
          </>
        )}
        <input
          aria-label="Cover image link"
          placeholder="Paste an image link"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && /^(https?:|data:image\/|media\/)/.test(link.trim())) onPick({ kind: "image", value: link.trim() });
          }}
        />
      </div>
      {error && <p className="kx-inline-error">{error}</p>}
    </Popover>
  );
}

function IconPicker({ onPick, onClose, onRemove }: { onPick: (icon: string) => void; onClose: () => void; onRemove?: () => void }) {
  return (
    <Popover onClose={onClose} className="kx-icon-picker">
      <div className="kx-icon-picker-head">
        <h4>Icon</h4>
        {onRemove && <button onClick={onRemove}>Remove</button>}
      </div>
      <div className="kx-icon-picker-grid">
        {PAGE_ICONS.map((icon) => (
          <button key={icon} aria-label={`Icon ${icon}`} onClick={() => onPick(icon)}>
            {icon}
          </button>
        ))}
      </div>
    </Popover>
  );
}

/** The icon above the title, and the hover buttons that add an icon or a cover. */
function PageHeading({ appearance, onAppearance, media, defaultIcon }: { appearance: PageAppearance; onAppearance?: (p: AppearancePatch) => void; media?: PageMedia; defaultIcon: IconName }) {
  const [picker, setPicker] = useState<"icon" | "cover">();
  if (!onAppearance && !appearance.icon) return null;
  return (
    <div className="kx-page-heading">
      {appearance.icon && (
        <button className="kx-page-icon" aria-label="Change icon" disabled={!onAppearance} onClick={() => setPicker("icon")}>
          {appearance.icon}
        </button>
      )}
      {onAppearance && (!appearance.icon || !appearance.cover) && (
        <div className="kx-page-heading-actions">
          {!appearance.icon && (
            <button onClick={() => setPicker("icon")}>
              <Icon name={defaultIcon} size={12} /> Add icon
            </button>
          )}
          {!appearance.cover && (
            <button onClick={() => setPicker("cover")}>
              <Icon name="image" size={12} /> Add cover
            </button>
          )}
        </div>
      )}
      {picker === "icon" && onAppearance && (
        <IconPicker
          onPick={(icon) => {
            onAppearance({ icon });
            setPicker(undefined);
          }}
          onRemove={appearance.icon ? () => (onAppearance({ icon: null }), setPicker(undefined)) : undefined}
          onClose={() => setPicker(undefined)}
        />
      )}
      {picker === "cover" && onAppearance && (
        <CoverPicker
          media={media}
          onPick={(cover) => {
            onAppearance({ cover });
            setPicker(undefined);
          }}
          onClose={() => setPicker(undefined)}
        />
      )}
    </div>
  );
}

/** Every standard field once, under the label it has on most sources. */
export const ALL_FIELDS: FieldSpec[] = (() => {
  const seen = new Map<string, FieldSpec>();
  for (const spec of [...DEFAULT_FIELDS, ...Object.values(FIELDS).flat(), ...MORE_FIELDS]) if (!seen.has(spec[0])) seen.set(spec[0], spec);
  return [...seen.values()];
})();

/**
 * The property block of a page item that is not a source (a note): Author first, then the
 * standard fields and properties it has. "Add a property" offers any standard field, any
 * workspace property, or a new one. Emptied rows stay until removed.
 */
export function ItemProperties({
  id,
  fields,
  properties,
  definitions,
  onFields,
  onProperties,
  onEditDefinition,
  onNewProperty,
}: {
  id: string;
  fields: Record<string, unknown>;
  properties: Record<string, unknown>;
  definitions: PropertyDefinition[];
  /** Patches; null removes a key. */
  onFields: (patch: Record<string, unknown>) => void;
  onProperties: (patch: Record<string, unknown>) => void;
  onEditDefinition: (definition: PropertyDefinition) => void;
  onNewProperty: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const shownFields = ALL_FIELDS.filter(([key]) => key in fields);
  const shownDefinitions = definitions.filter((d) => d.name in properties);
  const freeForm = Object.fromEntries(Object.entries(properties).filter(([key]) => !definitions.some((d) => d.name === key)));
  const addableFields = ALL_FIELDS.filter(([key]) => !(key in fields));
  const addableDefinitions = definitions.filter((d) => !(d.name in properties));
  const creators = Array.isArray(fields.creators) ? (fields.creators as Creator[]) : [];
  return (
    <section className="kx-page-properties kx-item-properties" aria-label="Properties">
      <div className="kx-field-row kx-page-chips kx-page-author">
        <span>Author</span>
        <Creators creators={creators} onCommit={(next) => onFields({ creators: next })} />
      </div>
      {shownFields.map(([key, label, kind]) => (
        <div className="kx-page-field" key={key}>
          <FieldRow
            label={label}
            kind={kind}
            value={fields[key] as string | number | undefined}
            onCommit={(value) => onFields({ [key]: kind === "number" ? (value === "" ? "" : Number(value)) : value })}
          />
          <button className="kx-row-remove" title={`Remove “${label}”`} aria-label={`Remove ${label}`} onClick={() => onFields({ [key]: null })}>
            <Icon name="close" size={10} />
          </button>
        </div>
      ))}
      <TypedProperties
        source={{ id, properties: { ...freeForm, ...Object.fromEntries(shownDefinitions.map((d) => [d.name, properties[d.name]])) } }}
        definitions={shownDefinitions}
        onCommit={onProperties}
        onEdit={onEditDefinition}
        formula={() => ""}
      />
      <div className="kx-page-properties-foot">
        <div className="kx-menu">
          <button aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding(!adding)}>
            <Icon name="plus" size={11} /> Add a property
          </button>
          {adding && (
            <Popover onClose={() => setAdding(false)} className="kx-add-property">
              {addableDefinitions.length > 0 && <h4>Properties</h4>}
              {addableDefinitions.map((d) => (
                <button
                  key={d.name}
                  role="menuitem"
                  onClick={() => {
                    onProperties({ [d.name]: d.type === "boolean" ? false : "" });
                    setAdding(false);
                  }}
                >
                  {d.name}
                </button>
              ))}
              <h4>Fields</h4>
              {addableFields.map(([key, label]) => (
                <button
                  key={key}
                  role="menuitem"
                  onClick={() => {
                    onFields({ [key]: "" });
                    setAdding(false);
                  }}
                >
                  {label}
                </button>
              ))}
              <button
                role="menuitem"
                className="kx-add-property-new"
                onClick={() => {
                  setAdding(false);
                  onNewProperty();
                }}
              >
                <Icon name="plus" size={11} /> New property…
              </button>
            </Popover>
          )}
        </div>
      </div>
    </section>
  );
}

