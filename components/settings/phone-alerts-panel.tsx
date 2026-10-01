"use client";

// Settings > Phone alerts (B31). Web Push to this installed app. iOS allows it
// only for a home-screen app (16.4 and later) and only when the permission is
// asked from a tap, so everything that subscribes runs inside the button's
// click handler. With the push keys missing, the panel says alerts are not set
// up yet and nothing else happens.

import { useState, useSyncExternalStore, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  removePushSubscriptionAction,
  savePushSubscriptionAction,
  sendTestAlertAction,
} from "@/app/(app)/settings/actions";

export interface DeviceView {
  id: string;
  label: string;
  added_label: string;
  last_ok_label: string | null;
  last_error_label: string | null;
}

type Readiness = "server" | "unsupported" | "needs_install" | "ready";

function readiness(): Readiness {
  const ua = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  if (isIos && !standalone) return "needs_install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    return "unsupported";
  }
  return "ready";
}

const noSubscribe = () => () => {};

function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}

function keyToBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export default function PhoneAlertsPanel({ devices }: { devices: DeviceView[] }) {
  const state = useSyncExternalStore<Readiness>(noSubscribe, readiness, () => "server");
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Runs from the tap. Order matters on iOS: permission first, from the tap.
  function turnOn() {
    setMessage(null);
    startTransition(async () => {
      try {
        const keyRes = await fetch("/api/push/key", { cache: "no-store" });
        const key = (await keyRes.json()) as { configured?: boolean; public_key?: string };
        if (!key.configured || !key.public_key) {
          setMessage("Alerts are not set up yet. The push keys have to be added in Vercel first.");
          return;
        }
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          setMessage("Alerts were not allowed. Allow notifications for Life OS in the device settings, then try again.");
          return;
        }
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        const sub =
          existing ??
          (await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyToBytes(key.public_key),
          }));
        const json = sub.toJSON();
        const r = await savePushSubscriptionAction({
          endpoint: json.endpoint ?? "",
          p256dh: json.keys?.p256dh ?? "",
          auth: json.keys?.auth ?? "",
          device_label: deviceLabel(),
        });
        setMessage(r.message);
        router.refresh();
      } catch {
        setMessage("Could not turn alerts on for this device. Try again from the home-screen app.");
      }
    });
  }

  function remove(id: string) {
    startTransition(async () => {
      const r = await removePushSubscriptionAction(id);
      setMessage(r.message);
      router.refresh();
    });
  }

  function test() {
    setMessage(null);
    startTransition(async () => {
      const r = await sendTestAlertAction();
      setMessage(r.message);
      router.refresh();
    });
  }

  return (
    <div className="rounded-2xl border border-border bg-surface p-4 shadow-[var(--shadow-card)]">
      {state === "needs_install" && (
        <p className="text-sm text-secondary">
          Add Life OS to your Home Screen first, then open it from there. iPhone and iPad
          only allow alerts for an app on the Home Screen.
        </p>
      )}
      {state === "unsupported" && (
        <p className="text-sm text-secondary">This browser cannot receive alerts.</p>
      )}
      <div className="mt-1 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={turnOn}
          disabled={pending || state !== "ready"}
          className="press min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm disabled:opacity-50"
        >
          Turn on alerts on this device
        </button>
        <button
          type="button"
          onClick={test}
          disabled={pending || devices.length === 0}
          className="press min-h-11 rounded-lg border border-border-strong px-3 py-2 text-sm disabled:opacity-50"
        >
          Send a test alert
        </button>
      </div>
      {message && <p className="mt-2 text-sm text-accent">{message}</p>}

      {devices.length > 0 && (
        <ul className="mt-3 divide-y divide-border">
          {devices.map((d) => (
            <li key={d.id} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <p className="font-medium">{d.label}</p>
                <p className="text-xs text-secondary">
                  Added {d.added_label}
                  {d.last_ok_label ? `, last alert ${d.last_ok_label}` : ", no alert yet"}
                  {d.last_error_label ? `, last problem ${d.last_error_label}` : ""}
                </p>
              </div>
              <button
                type="button"
                disabled={pending}
                onClick={() => remove(d.id)}
                className="shrink-0 rounded-lg border border-overdue/40 px-3 py-1 text-xs font-medium text-overdue disabled:opacity-50"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-secondary">
        Nothing is sent between 10 PM and 7 AM, and at most 20 alerts go out in a day. Alert
        text shows on the lock screen: on iPhone, Settings, Notifications, Show Previews,
        &quot;When Unlocked&quot; hides it until you unlock.
      </p>
    </div>
  );
}
