import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Drawer } from "./motion/Drawer";
import "./global-drawer.css";
type Entry = {
  id: string;
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
};
let current: Entry | null = null;
const listeners = new Set<() => void>();
const publish = (entry: Entry | null) => {
  current = entry;
  listeners.forEach((fn) => fn());
};
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function GlobalDrawer({
  children,
  onClose,
  busy,
}: {
  children: ReactNode;
  onClose: () => void;
  busy?: boolean;
}) {
  const id = useId();
  useLayoutEffect(() => {
    publish({ id, children, onClose, busy });
  });
  useLayoutEffect(
    () => () => {
      if (current?.id === id) publish(null);
    },
    [id],
  );
  return null;
}
type Frame = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  image: string;
};
const bridge = () => (window as any).key;
export function GlobalDrawerHost() {
  const entry = useSyncExternalStore(subscribe, () => current);
  const [ready, setReady] = useState(false),
    [frames, setFrames] = useState<Frame[]>([]);
  const lease = useRef<string | undefined>(undefined),
    savedFocus = useRef<HTMLElement | null>(null),
    last = useRef<Entry | null>(null);
  if (entry) last.current = entry;
  const release = () => {
    const id = lease.current;
    if (current || !id) return;
    lease.current = undefined;
    setReady(false);
    setFrames([]);
    last.current = null;
    void bridge().tabAction("global-overlay-close", { id });
    const body = document.querySelector<HTMLElement>(".key-shell-body");
    if (body) body.inert = false;
    savedFocus.current?.isConnected && savedFocus.current.focus();
  };
  useEffect(() => {
    if (!entry || lease.current) return;
    const id = crypto.randomUUID();
    lease.current = id;
    savedFocus.current = document.activeElement as HTMLElement;
    void bridge()
      .tabAction("global-overlay-open", { id })
      .then((result: { frames: Frame[] }) => {
        if (lease.current !== id) return;
        setFrames(result.frames);
        setReady(true);
        if (!current) {
          lease.current = undefined;
          setReady(false);
          setFrames([]);
          void bridge().tabAction("global-overlay-close", { id });
        }
      })
      .catch(() => {
        if (lease.current !== id) return;
        lease.current = undefined;
        setFrames([]);
        setReady(false);
        current?.onClose();
      });
  }, [entry?.id]);
  useEffect(() => {
    const body = document.querySelector<HTMLElement>(".key-shell-body");
    if (body) body.inert = ready;
    return () => {
      if (body) body.inert = false;
    };
  }, [ready]);
  useEffect(
    () =>
      bridge().on(
        "global-overlay-frames",
        (result: { id: string; frames: Frame[] }) => {
          if (result.id === lease.current) setFrames(result.frames);
        },
      ),
    [],
  );
  useEffect(
    () => () => {
      const id = lease.current;
      lease.current = undefined;
      if (id) void bridge().tabAction("global-overlay-close", { id });
    },
    [],
  );
  return createPortal(
    <>
      {ready &&
        frames.map((frame) => (
          <img
            key={frame.id}
            className="key-native-overlay-frame"
            alt=""
            draggable={false}
            src={frame.image}
            style={{
              left: frame.x,
              top: frame.y,
              width: frame.width,
              height: frame.height,
            }}
          />
        ))}
      <Drawer
        open={ready && !!entry}
        onClose={() => {
          if (!current?.busy) current?.onClose();
        }}
        onExitComplete={release}
      >
        {(entry || last.current)?.children}
      </Drawer>
    </>,
    document.body,
  );
}
