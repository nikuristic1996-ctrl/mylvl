import { useEffect, useState, type FormEvent } from "react";
import { Link, NavLink, Route, Routes, useLocation } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import {
  Activity as ActivityIcon,
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  Bell,
  Bike,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Download,
  Dumbbell,
  Flame,
  Footprints,
  Heart,
  Home,
  ImagePlus,
  Leaf,
  ListFilter,
  Menu,
  Plus,
  Settings,
  Shield,
  Sparkles,
  Target,
  TrendingUp,
  Upload,
  Waves,
  X,
  Zap,
} from "lucide-react";
import {
  formatDate,
  levelForXp,
  loadData,
  saveData,
  type Activity,
  type ActivityType,
  type AppData,
  type Avatar,
} from "./domain";
import { calculateActivityXp, type ActivityType as EngineActivityType } from "./gameEngine";
import { supabase } from "./supabase";
import { fingerprintScreenshot, parseLocalizedNumber, recognizeScreenshot, screenshotFileError, type ScreenshotDraft, type ScreenshotParseReport } from "./screenshotOcr";
import { estimateRunningSteps } from "./stepEstimation";
import {
  loadCloudData,
  recordCloudActivity,
  saveCloudAvatar,
  type ArchivedSeasonSnapshot,
  type RecentExperienceTransaction,
  type SeasonSnapshot,
} from "./supabaseData";

const nav = [
  { to: "/", label: "Overview", icon: Home },
  { to: "/avatar", label: "Avatar", icon: Sparkles },
  { to: "/activities", label: "Activities", icon: ActivityIcon },
  { to: "/progress", label: "Progress", icon: TrendingUp },
  { to: "/import", label: "Import", icon: Upload },
  { to: "/settings", label: "Settings", icon: Settings },
];
const activityTypes: ActivityType[] = [
  "Walking",
  "Running",
  "Strength",
  "Bodyweight",
  "Yoga",
  "Pilates",
  "Cycling",
  "Swimming",
  "Other",
];
const engineActivityType: Partial<Record<ActivityType, EngineActivityType>> = {
  Walking: "walking",
  Running: "running",
  Cycling: "cycling",
  Swimming: "swimming",
  Strength: "strength",
  Yoga: "yoga",
  Pilates: "pilates",
  "Push-ups": "pushups",
  Squats: "squats",
  "Sit-ups": "situps",
  Plank: "plank",
  "Pull-ups": "pullups",
};
function activityXpPreview({
  type,
  duration,
  distance,
  steps,
  repetitions,
  holdSeconds,
  activeCalories,
  source,
  confirmed,
  demo,
}: {
  type: ActivityType;
  duration: number;
  distance?: number;
  steps?: number;
  repetitions?: number;
  holdSeconds?: number;
  activeCalories?: number;
  source: "manual" | "screenshot";
  confirmed?: boolean;
  demo?: boolean;
}) {
  const ruleType = engineActivityType[type];
  if (!ruleType) return 0;
  return calculateActivityXp({
    type: ruleType,
    source,
    demo,
    screenshotConfirmed: confirmed,
    recordedSession: source === "manual" ? false : undefined,
    dailyStepsReconciled: false,
    metrics: {
      durationMinutes: duration,
      distanceKm: distance,
      steps,
      repetitions,
      holdSeconds,
      activeCalories,
    },
  }).xp;
}
const days = ["M", "T", "W", "T", "F", "S", "S"];
const chartBars = [38, 64, 45, 80, 56, 93, 68];

type AppInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

export default function App() {
  const [data, setData] = useState<AppData>(loadData);
  const [session, setSession] = useState<Session | null>(null);
  const [cloudTotalXp, setCloudTotalXp] = useState<number | null>(null);
  const [cloudSeason, setCloudSeason] = useState<SeasonSnapshot | null>(null);
  const [seasonHistory, setSeasonHistory] = useState<ArchivedSeasonSnapshot[]>([]);
  const [recentTransactions, setRecentTransactions] = useState<RecentExperienceTransaction[]>([]);
  const [cloudState, setCloudState] = useState<
    "local" | "loading" | "ready" | "error"
  >(supabase ? "loading" : "local");
  const [showAdd, setShowAdd] = useState(false);
  const [toast, setToast] = useState("");
  const [installPrompt, setInstallPrompt] =
    useState<AppInstallPromptEvent | null>(null);
  const [appInstalled, setAppInstalled] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const location = useLocation();
  const userId = session?.user.id ?? null;
  const userEmail = session?.user.email ?? null;
  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((navigator as Navigator & { standalone?: boolean }).standalone);
    setAppInstalled(standalone);

    const handleBeforeInstall = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as AppInstallPromptEvent);
    };
    const handleInstalled = () => {
      setAppInstalled(true);
      setInstallPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleInstalled);
    };
  }, []);
  useEffect(() => {
    const showUpdate = () => setUpdateAvailable(true);
    const hideUpdate = () => setUpdateAvailable(false);
    window.addEventListener("mylvl:pwa-update-ready", showUpdate);
    window.addEventListener("mylvl:pwa-update-applied", hideUpdate);
    return () => {
      window.removeEventListener("mylvl:pwa-update-ready", showUpdate);
      window.removeEventListener("mylvl:pwa-update-applied", hideUpdate);
    };
  }, []);
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    void supabase.auth.getSession().then(({ data: authData }) => {
      if (active) setSession(authData.session);
    });
    const { data: authListener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => {
        setSession(nextSession);
      },
    );
    return () => {
      active = false;
      authListener.subscription.unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!userId) {
      setData(loadData());
      setCloudTotalXp(null);
      setCloudSeason(null);
      setSeasonHistory([]);
      setRecentTransactions([]);
      setCloudState("local");
      return;
    }
    let active = true;
    setCloudState("loading");
    void loadCloudData(userId)
      .then(({ data: cloudData, totalXp: xp, season, seasonHistory: history, recentTransactions: transactions }) => {
        if (!active) return;
        setData(cloudData);
        setCloudTotalXp(xp);
        setCloudSeason(season);
        setSeasonHistory(history);
        setRecentTransactions(transactions);
        setCloudState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setData({
          activities: [],
          avatar: {
            name: userEmail?.split("@")[0] ?? "Adventurer",
            hair: "#b7f56a",
            skin: "#d89b73",
            outfit: "#a893ff",
          },
        });
        setCloudTotalXp(0);
        setCloudSeason(null);
        setSeasonHistory([]);
        setRecentTransactions([]);
        setCloudState("error");
        setToast(
          error instanceof Error
            ? `Cloud sync failed: ${error.message}`
            : "Cloud sync failed.",
        );
      });
    return () => {
      active = false;
    };
  }, [userId, userEmail]);
  useEffect(() => {
    if (!userId) saveData(data);
  }, [data, userId]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3200);
    return () => clearTimeout(timer);
  }, [toast]);
  const totalXp = session
    ? cloudTotalXp ?? 0
    : data.activities.reduce((sum, item) => sum + item.xp, 0) + 1240;
  const level = levelForXp(totalXp);
  const addActivity = async (activity: Activity) => {
    if (session && cloudState !== "ready") {
      setToast("Wait until your cloud profile finishes loading.");
      return false;
    }
    if (
      activity.sourceKey &&
      data.activities.some((item) => item.sourceKey === activity.sourceKey)
    ) {
      setToast("This activity was already imported.");
      return false;
    }
    let savedActivity = activity;
    if (session && supabase) {
      try {
        const result = await recordCloudActivity(activity);
        if (result.duplicate) {
          setToast("This activity was already imported.");
          return false;
        }
        const refreshed = await loadCloudData(session.user.id);
        setData(refreshed.data);
        setCloudTotalXp(refreshed.totalXp);
        setCloudSeason(refreshed.season);
        setSeasonHistory(refreshed.seasonHistory);
        setRecentTransactions(refreshed.recentTransactions);
        setToast(
          result.xp > 0
            ? `+${result.xp} XP awarded · nice work`
            : activity.demo
              ? "Demo activity saved. It earned no EXP."
              : result.status === "requires_review" || result.status === "requires-review"
                ? "Activity saved for review; no EXP was awarded."
                : "Activity saved. This source is not eligible for EXP.",
        );
        return true;
      } catch (error) {
        setToast(
          error instanceof Error
            ? `Could not save activity: ${error.message}`
            : "Could not save activity.",
        );
        return false;
      }
    }
    setData((current) => ({
      ...current,
      activities: [savedActivity, ...current.activities],
    }));
    setToast(
      savedActivity.xp > 0
        ? `+${savedActivity.xp} demo EXP · local to this device`
        : "Activity saved locally without EXP.",
    );
    return true;
  };
  const updateAvatar = async (avatar: Avatar) => {
    if (session && cloudState !== "ready") {
      setToast("Wait until your cloud profile finishes loading.");
      return;
    }
    if (session) {
      try {
        await saveCloudAvatar(session.user.id, avatar);
      } catch (error) {
        setToast(
          error instanceof Error
            ? `Could not save avatar: ${error.message}`
            : "Could not save avatar.",
        );
        return;
      }
    }
    setData((current) => ({ ...current, avatar }));
    setToast(
      session
        ? "Avatar saved to your account."
        : "Avatar saved on this device.",
    );
  };
  const pageTitle =
    nav.find((item) => item.to === location.pathname)?.label ?? "Overview";
  return (
    <div className="app-shell">
      {updateAvailable && (
        <div className="pwa-update-banner" role="status" aria-live="polite">
          <span>A new MYLVL version is available.</span>
          <button type="button" onClick={() => window.dispatchEvent(new Event("mylvl:pwa-update-apply"))}>Update</button>
          <button type="button" className="pwa-update-dismiss" aria-label="Dismiss update notice" onClick={() => setUpdateAvailable(false)}><X size={16} /></button>
        </div>
      )}
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <span />
          </span>
          <span>
            mylvl<span className="brand-period">.</span>
          </span>
        </Link>
        <div className="workspace-label">YOUR SPACE</div>
        <nav className="side-nav">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === "/"}
              className={({ isActive }) =>
                `nav-link${isActive ? " active" : ""}`
              }
            >
              <item.icon size={18} strokeWidth={1.8} />
              <span>{item.label}</span>
              {item.to === "/progress" && <i className="nav-dot" />}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="season-card">
            <div className="season-icon">
              <Zap size={16} fill="currentColor" />
            </div>
            <div>
              <b>{cloudSeason?.name ?? "No season scheduled"}</b>
              <span>
                {cloudSeason
                  ? `Level ${cloudSeason.progress.level} · ${cloudSeason.progress.rank}`
                  : session && cloudState === "loading"
                    ? "Loading season progress"
                    : "Waiting for a season schedule"}
              </span>
            </div>
            <ChevronRight size={16} />
          </div>
          <button
            className="profile-mini"
            onClick={() => window.location.assign("/settings")}
          >
            <AvatarFace avatar={data.avatar} small />
            <span>
              <b>{data.avatar.name}</b>
              <small>Level {level.level} adventurer</small>
            </span>
            <ChevronDown size={15} />
          </button>
        </div>
      </aside>
      <main className="main-area">
        <header className="topbar">
          <div className="mobile-brand">
            <span className="brand-mark">
              <span />
            </span>
            mylvl<span className="brand-period">.</span>
          </div>
          <div className="breadcrumb">
            <span>My space</span>
            <ChevronRight size={14} />
            {pageTitle}
          </div>
          <div className="top-actions">
            <div className="streak-chip">
              <Flame size={15} fill="currentColor" /> <b>4</b>
              <span>day streak</span>
            </div>
            <button aria-label="Notifications" className="icon-button">
              <Bell size={18} />
              <i />
            </button>
            <button aria-label="Help" className="icon-button help-button">
              <CircleHelp size={18} />
            </button>
            <AvatarFace avatar={data.avatar} small />
          </div>
        </header>
        <div className="content-wrap">
          <Routes>
            <Route
              path="/"
              element={
                <Dashboard
                  data={data}
                  totalXp={totalXp}
                  level={level}
                  onAdd={() => setShowAdd(true)}
                />
              }
            />
            <Route
              path="/avatar"
              element={
                <AvatarPage
                  avatar={data.avatar}
                  totalXp={totalXp}
                  level={level}
                  update={updateAvatar}
                />
              }
            />
            <Route
              path="/activities"
              element={
                <ActivitiesPage
                  activities={data.activities}
                  onAdd={() => setShowAdd(true)}
                />
              }
            />
            <Route
              path="/progress"
              element={
                <ProgressPage
                  activities={data.activities}
                  totalXp={totalXp}
                  level={level}
                  season={cloudSeason}
                  seasonHistory={seasonHistory}
                  recentTransactions={recentTransactions}
                  cloudState={cloudState}
                />
              }
            />
            <Route
              path="/import"
              element={<ImportPage addActivity={addActivity} userId={userId} activities={data.activities} heightCm={data.avatar.heightCm} />}
            />
            <Route
              path="/settings"
              element={
                <SettingsPage
                  session={session}
                  cloudState={cloudState}
                  installPrompt={installPrompt}
                  appInstalled={appInstalled}
                  onInstallPromptConsumed={() => setInstallPrompt(null)}
                />
              }
            />
            <Route
              path="*"
              element={
                <Dashboard
                  data={data}
                  totalXp={totalXp}
                  level={level}
                  onAdd={() => setShowAdd(true)}
                />
              }
            />
          </Routes>
        </div>
      </main>
      <nav className="mobile-nav">
        {[
          { to: "/", label: "Home", icon: Home },
          { to: "/avatar", label: "Avatar", icon: Sparkles },
          { to: "/activities", label: "Activity", icon: ActivityIcon },
          { to: "/import", label: "Import", icon: Upload },
          { to: "/settings", label: "Profile", icon: Menu },
        ].map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === "/"}
            className={({ isActive }) =>
              `mobile-nav-link${isActive ? " active" : ""}`
            }
          >
            <item.icon size={19} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      {showAdd && (
        <ActivityModal
          onClose={() => setShowAdd(false)}
          onSave={(activity) => {
            void addActivity(activity).then((saved) => {
              if (saved) setShowAdd(false);
            });
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <span className="toast-check">
            <Check size={15} />
          </span>
          {toast}
          <button onClick={() => setToast("")} aria-label="Dismiss">
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}

function AvatarFace({
  avatar,
  small = false,
}: {
  avatar: Avatar;
  small?: boolean;
}) {
  return (
    <div
      className={`avatar-face${small ? " avatar-small" : ""}`}
      style={
        {
          "--hair": avatar.hair,
          "--skin": avatar.skin,
          "--outfit": avatar.outfit,
        } as React.CSSProperties
      }
    >
      <div className="avatar-hair" />
      <div className="avatar-ear ear-left" />
      <div className="avatar-ear ear-right" />
      <div className="avatar-head">
        <i className="eye left-eye" />
        <i className="eye right-eye" />
        <i className="smile" />
      </div>
      <div className="avatar-neck" />
      <div className="avatar-body" />
    </div>
  );
}
function PageHeading({
  eyebrow,
  title,
  detail,
  action,
}: {
  eyebrow: string;
  title: React.ReactNode;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        <p>{detail}</p>
      </div>
      {action}
    </div>
  );
}
function LevelCard({
  totalXp,
  level,
}: {
  totalXp: number;
  level: ReturnType<typeof levelForXp>;
}) {
  const progress = (level.current / level.needed) * 100;
  return (
    <section className="panel level-card">
      <div className="level-top">
        <div>
          <div className="eyebrow">YOUR JOURNEY</div>
          <h2>
            Level <strong>{level.level}</strong>
          </h2>
          <p>Every move adds up. Keep going.</p>
        </div>
        <div className="level-badge">
          <span>LVL</span>
          <b>{level.level}</b>
        </div>
      </div>
      <div className="xp-labels">
        <span>
          <b>{level.current.toLocaleString()}</b> XP
        </span>
        <span>
          {level.needed.toLocaleString()} XP to level {level.level + 1}
        </span>
      </div>
      <div className="xp-track">
        <span style={{ width: `${Math.max(4, progress)}%` }} />
      </div>
      <div className="xp-foot">
        <span>
          <Zap size={14} fill="currentColor" /> {totalXp.toLocaleString()} total
          XP
        </span>
        <span>{Math.round(progress)}% complete</span>
      </div>
    </section>
  );
}
function Dashboard({
  data,
  totalXp,
  level,
  onAdd,
}: {
  data: AppData;
  totalXp: number;
  level: ReturnType<typeof levelForXp>;
  onAdd: () => void;
}) {
  const today = new Date().toDateString();
  const todayLabel = new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  })
    .format(new Date())
    .toUpperCase();
  const todayItems = data.activities.filter(
    (item) => new Date(item.date).toDateString() === today,
  );
  const todayXp = todayItems.reduce((sum, item) => sum + item.xp, 0);
  const activeDays = new Set(
    data.activities
      .filter(
        (item) => Date.now() - new Date(item.date).getTime() < 7 * 86400000,
      )
      .map((item) => new Date(item.date).getDay()),
  ).size;
  return (
    <>
      <PageHeading
        eyebrow={todayLabel}
        title={
          <>
            A little better,
            <br className="mobile-break" /> every day
            <span className="heading-period">.</span>
          </>
        }
        detail="Your real life is your greatest adventure."
        action={
          <button className="primary-button" onClick={onAdd}>
            <Plus size={17} /> Log activity
          </button>
        }
      />
      <div className="dashboard-grid">
        <div className="dashboard-main">
          <section className="welcome-card">
            <div className="welcome-copy">
              <div className="online-label">
                <span /> YOUR ADVENTURE IS IN PROGRESS
              </div>
              <h2>
                Hey, {data.avatar.name}
                <span className="wave">✳</span>
              </h2>
              <p>Show up for yourself today. The rest follows.</p>
              <Link className="text-link" to="/avatar">
                View your avatar <ArrowRight size={15} />
              </Link>
            </div>
            <div className="welcome-avatar">
              <div className="avatar-orbit orbit-one" />
              <div className="avatar-orbit orbit-two" />
              <AvatarFace avatar={data.avatar} />
              <div className="level-float">
                <span>LEVEL</span>
                <b>{level.level}</b>
              </div>
              <div className="sparkle-float">✦</div>
            </div>
            <div className="welcome-glow" />
          </section>
          <div className="section-heading">
            <div>
              <h2>Today at a glance</h2>
              <p>Small wins, big momentum.</p>
            </div>
            <span className="muted-date">TODAY</span>
          </div>
          <div className="stats-grid">
            <StatCard
              icon={<Zap size={16} />}
              label="XP earned"
              value={`+${todayXp}`}
              suffix="XP"
              note={todayXp > 0 ? "Keep that momentum" : "Start with one move"}
              accent="lime"
            />
            <StatCard
              icon={<Footprints size={16} />}
              label="Active minutes"
              value={todayItems.reduce((s, a) => s + a.duration, 0)}
              suffix="min"
              note={`${todayItems.length} activities logged`}
              accent="purple"
            />
            <StatCard
              icon={<Target size={16} />}
              label="Weekly goal"
              value={`${activeDays}/5`}
              suffix="days"
              note={
                activeDays >= 5
                  ? "Goal complete"
                  : `${5 - Math.min(activeDays, 5)} days to your goal`
              }
              accent="blue"
            />
          </div>
          <div className="section-heading activity-section-title">
            <div>
              <h2>Recent activity</h2>
              <p>Your effort, all in one place.</p>
            </div>
            <Link to="/activities" className="subtle-link">
              See all <ArrowRight size={14} />
            </Link>
          </div>
          <ActivityList activities={data.activities.slice(0, 3)} />
        </div>
        <aside className="dashboard-side">
          <LevelCard totalXp={totalXp} level={level} />
          <section className="panel week-card">
            <div className="card-heading">
              <div>
                <div className="eyebrow">YOUR CONSISTENCY</div>
                <h3>This week</h3>
              </div>
              <button className="dots-button" aria-label="More options">
                ···
              </button>
            </div>
            <div className="week-chart">
              {chartBars.map((height, i) => (
                <div className="week-day" key={i}>
                  <div className="week-bar-track">
                    <span
                      className={i === 3 ? "today-bar" : ""}
                      style={{ height: `${height}%` }}
                    />
                  </div>
                  <small>{days[i]}</small>
                </div>
              ))}
            </div>
            <div className="week-legend">
              <span>
                <i /> Active
              </span>
              <b>{activeDays} active days</b>
            </div>
          </section>
          <section className="quote-card">
            <span className="quote-mark">“</span>
            <p>
              We are what we repeatedly do. Excellence, then, is not an act, but
              a habit.
            </p>
            <span className="quote-credit">
              ARISTOTLE <i />
            </span>
          </section>
        </aside>
      </div>
    </>
  );
}
function StatCard({
  icon,
  label,
  value,
  suffix,
  note,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  suffix: string;
  note: string;
  accent: string;
}) {
  return (
    <div className="panel stat-card">
      <div className={`stat-icon ${accent}`}>{icon}</div>
      <span className="stat-label">{label}</span>
      <div className="stat-value">
        {value}
        <span>{suffix}</span>
      </div>
      <small>{note}</small>
    </div>
  );
}
function ActivityList({ activities }: { activities: Activity[] }) {
  if (!activities.length)
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <ActivityIcon size={20} />
        </div>
        <b>Your next chapter starts here.</b>
        <p>Log an activity and watch your progress grow.</p>
      </div>
    );
  return (
    <div className="panel activity-list">
      {activities.map((item) => (
        <div className="activity-row" key={item.id}>
          <div className={`activity-icon ${item.type.toLowerCase()}`}>
            {activityIcon(item.type)}
          </div>
          <div className="activity-info">
            <b>{item.type}</b>
            <span>
              {formatDate(item.date)}
              {item.notes ? ` · ${item.notes}` : ""}
              {item.validationStatus ? ` · ${activityValidationLabel(item.validationStatus)}` : ""}
            </span>
          </div>
          <div className="activity-metric">
            <b>
              {item.duration} <small>min</small>
            </b>
            <span>
              {item.distance
                ? `${item.distance} km`
                : `${item.calories ?? "—"} kcal`}
            </span>
          </div>
          <div className="activity-xp">
            +{item.xp} <small>XP</small>
          </div>
          <ChevronRight className="activity-chevron" size={16} />
        </div>
      ))}
    </div>
  );
}
function activityValidationLabel(status: NonNullable<Activity["validationStatus"]>) {
  const labels: Record<NonNullable<Activity["validationStatus"]>, string> = {
    unverified: "Unverified",
    user_confirmed: "User confirmed",
    provider_verified: "Provider verified",
    pose_validated: "Camera checked",
    pending_review: "Pending review",
    rejected: "Not eligible for EXP",
    demo: "Demo only",
    legacy_unreviewed: "Legacy record",
  };
  return labels[status];
}
function activityIcon(type: ActivityType) {
  const common = { size: 17, strokeWidth: 1.8 };
  if (type === "Running") return <TrendingUp {...common} />;
  if (type === "Cycling") return <Bike {...common} />;
  if (type === "Strength" || type === "Bodyweight")
    return <Dumbbell {...common} />;
  if (type === "Swimming") return <Waves {...common} />;
  if (type === "Yoga" || type === "Pilates") return <Leaf {...common} />;
  return <Footprints {...common} />;
}

function AvatarPage({
  avatar,
  totalXp,
  level,
  update,
}: {
  avatar: Avatar;
  totalXp: number;
  level: ReturnType<typeof levelForXp>;
  update: (avatar: Avatar) => void;
}) {
  const [draft, setDraft] = useState(avatar);
  useEffect(() => setDraft(avatar), [avatar]);
  const save = (event: FormEvent) => {
    event.preventDefault();
    update(draft);
  };
  return (
    <>
      <PageHeading
        eyebrow="CHARACTER PROFILE"
        title="Meet your avatar."
        detail="A reflection of the work you put in."
      />
      <div className="avatar-layout">
        <section className="panel character-card">
          <div className="character-glow" />
          <div className="character-art">
            <div className="avatar-orbit orbit-one" />
            <div className="avatar-orbit orbit-two" />
            <AvatarFace avatar={draft} />
            <span className="character-spark">✦</span>
          </div>
          <span className="class-tag">
            <Sparkles size={13} /> EVERYDAY HERO
          </span>
          <h2>{draft.name || "Your avatar"}</h2>
          <p>Level {level.level} · Trailblazer</p>
          <div className="character-stats">
            <span>
              <b>{totalXp.toLocaleString()}</b>
              <small>TOTAL XP</small>
            </span>
            <span>
              <b>{level.level}</b>
              <small>LEVEL</small>
            </span>
            <span>
              <b>4 days</b>
              <small>STREAK</small>
            </span>
          </div>
        </section>
        <form className="panel customize-card" onSubmit={save}>
          <div className="eyebrow">MAKE IT YOURS</div>
          <h2>Character details</h2>
          <p>Change a few details to make your adventurer feel like you.</p>
          <label className="field-label">
            Avatar name
            <input
              value={draft.name}
              maxLength={20}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Choose a name"
            />
          </label>
          <label className="field-label">
            Height for step estimates (cm, optional)
            <input type="number" min="120" max="220" value={draft.heightCm ?? ""} onChange={(e) => setDraft({ ...draft, heightCm: e.target.value ? Number(e.target.value) : undefined })} />
          </label>
          <label className="field-label">
            Hair color
            <div className="swatch-row">
              {[
                "#b7f56a",
                "#a893ff",
                "#ec8caa",
                "#f5ba69",
                "#e8e9eb",
                "#6cbbed",
              ].map((color) => (
                <button
                  type="button"
                  aria-label={`Hair color ${color}`}
                  className={`swatch${draft.hair === color ? " selected" : ""}`}
                  style={{ backgroundColor: color }}
                  onClick={() => setDraft({ ...draft, hair: color })}
                  key={color}
                />
              ))}
            </div>
          </label>
          <label className="field-label">
            Skin tone
            <div className="swatch-row">
              {["#f0c8a8", "#d89b73", "#a96f51", "#80543f", "#603e37"].map(
                (color) => (
                  <button
                    type="button"
                    aria-label={`Skin tone ${color}`}
                    className={`swatch${draft.skin === color ? " selected" : ""}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setDraft({ ...draft, skin: color })}
                    key={color}
                  />
                ),
              )}
            </div>
          </label>
          <label className="field-label">
            Outfit color
            <div className="swatch-row">
              {["#a893ff", "#b7f56a", "#6cbbed", "#ec8caa", "#f5ba69"].map(
                (color) => (
                  <button
                    type="button"
                    aria-label={`Outfit ${color}`}
                    className={`swatch${draft.outfit === color ? " selected" : ""}`}
                    style={{ backgroundColor: color }}
                    onClick={() => setDraft({ ...draft, outfit: color })}
                    key={color}
                  />
                ),
              )}
            </div>
          </label>
          <button className="primary-button save-avatar" type="submit">
            <Check size={16} /> Save changes
          </button>
        </form>
      </div>
    </>
  );
}

function ActivitiesPage({
  activities,
  onAdd,
}: {
  activities: Activity[];
  onAdd: () => void;
}) {
  const [filter, setFilter] = useState("All activities");
  const [range, setRange] = useState("Any time");
  const filtered = activities.filter(
    (item) =>
      (filter === "All activities" || item.type === filter) &&
      (range === "Any time" ||
        Date.now() - new Date(item.date).getTime() <=
          (range === "7 days" ? 7 : 30) * 86400000),
  );
  return (
    <>
      <PageHeading
        eyebrow="THE JOURNEY SO FAR"
        title="Every move counts."
        detail="Your activity, effort, and earned XP."
        action={
          <button className="primary-button" onClick={onAdd}>
            <Plus size={17} /> Log activity
          </button>
        }
      />
      <div className="filter-row">
        <label className="select-wrap">
          <ListFilter size={15} />
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option>All activities</option>
            {activityTypes.map((type) => (
              <option key={type}>{type}</option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <label className="select-wrap">
          <Clock3 size={15} />
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            <option>Any time</option>
            <option>7 days</option>
            <option>30 days</option>
          </select>
          <ChevronDown size={14} />
        </label>
        <span className="result-count">
          {filtered.length} {filtered.length === 1 ? "activity" : "activities"}
        </span>
      </div>
      <ActivityList activities={filtered} />
    </>
  );
}
function ProgressPage({
  activities,
  totalXp,
  level,
  season,
  seasonHistory,
  recentTransactions,
  cloudState,
}: {
  activities: Activity[];
  totalXp: number;
  level: ReturnType<typeof levelForXp>;
  season: SeasonSnapshot | null;
  seasonHistory: ArchivedSeasonSnapshot[];
  recentTransactions: RecentExperienceTransaction[];
  cloudState: "local" | "loading" | "ready" | "error";
}) {
  const xpThisWeek = activities
    .filter(
      (item) => Date.now() - new Date(item.date).getTime() <= 7 * 86400000,
    )
    .reduce((sum, item) => sum + item.xp, 0);
  return (
    <>
      <PageHeading
        eyebrow="YOUR PROGRESS"
        title="Look how far you’ve come."
        detail="Consistency is the real superpower."
      />
      <div className="progress-overview">
        <LevelCard totalXp={totalXp} level={level} />
        <div className="panel progress-total">
          <div className="eyebrow">THIS WEEK</div>
          <div className="total-figure">
            +{xpThisWeek}
            <span> XP</span>
          </div>
          <div className="trend-note">
            <ArrowUpRight size={15} /> You're building a habit
          </div>
          <div className="progress-sparkline">
            <svg viewBox="0 0 300 75" preserveAspectRatio="none">
              <defs>
                <linearGradient id="line-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#b7f56a" stopOpacity=".2" />
                  <stop offset="1" stopColor="#b7f56a" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d="M0 62 C28 56 27 43 55 48 S93 24 120 42 S154 16 183 31 S215 42 237 20 S273 30 300 7 V75 H0Z"
                fill="url(#line-fill)"
              />
              <path
                d="M0 62 C28 56 27 43 55 48 S93 24 120 42 S154 16 183 31 S215 42 237 20 S273 30 300 7"
                fill="none"
                stroke="#b7f56a"
                strokeWidth="2.2"
              />
            </svg>
          </div>
        </div>
      </div>
      <section className="panel season-progression-card">
        <div>
          <div className="eyebrow">CURRENT SEASON</div>
          {cloudState === "loading" && !season ? (
            <p>Loading season progress…</p>
          ) : cloudState === "error" ? (
            <p>Season progress could not be loaded. Try again after cloud sync recovers.</p>
          ) : season ? (
            <>
              <h2>{season.name}</h2>
              <p>Level {season.progress.level} · {season.progress.rank} · {season.progress.totalXp.toLocaleString()} seasonal EXP</p>
              <div className="season-progress-track" aria-label={`${season.progress.currentXp} of ${season.progress.neededXp} EXP in current season level`}>
                <i style={{ width: `${Math.min(100, (season.progress.currentXp / season.progress.neededXp) * 100)}%` }} />
              </div>
              <small>{season.progress.capped ? "Season level cap reached" : `${season.progress.currentXp.toLocaleString()} / ${season.progress.neededXp.toLocaleString()} EXP to next season level`}</small>
            </>
          ) : (
            <p>No season has been scheduled yet. Seasonal progression will appear here once a UTC season window is configured.</p>
          )}
        </div>
      </section>
      <div className="section-heading progress-section">
        <div>
          <h2>Your milestones</h2>
          <p>Progress isn't always loud. It's always yours.</p>
        </div>
      </div>
      <div className="milestones-grid">
        <Milestone
          icon={<Flame size={19} />}
          name="Finding a rhythm"
          detail="Log activities on 5 different days"
          progress={Math.min(activities.length, 5)}
          max={5}
        />
        <Milestone
          icon={<Zap size={19} />}
          name="First 1,000 XP"
          detail="Earn your first thousand experience"
          progress={Math.min(totalXp, 1000)}
          max={1000}
        />
        <Milestone
          icon={<Heart size={19} />}
          name="Showing up"
          detail="Complete 10 real-life activities"
          progress={Math.min(activities.length, 10)}
          max={10}
        />
      </div>
      <div className="section-heading progress-section">
        <div>
          <h2>Recent EXP transactions</h2>
          <p>Server-recorded rewards from your account.</p>
        </div>
      </div>
      {cloudState === "loading" ? (
        <div className="panel progress-empty-state">Loading your EXP ledger…</div>
      ) : cloudState === "error" ? (
        <div className="panel progress-empty-state">The EXP ledger could not be loaded. Check your connection and try again.</div>
      ) : recentTransactions.length ? (
        <div className="panel xp-transaction-list">
          {recentTransactions.map((transaction) => (
            <div className="xp-transaction-row" key={transaction.id}>
              <span className="xp-transaction-icon"><Zap size={16} /></span>
              <span className="xp-transaction-copy">
                <b>{transaction.type === "step_settlement" ? "Daily steps" : "Activity reward"}</b>
                <small>{formatDate(transaction.createdAt)}</small>
              </span>
              <strong>+{transaction.amount.toLocaleString()} XP</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel progress-empty-state">No EXP transactions yet. Eligible, confirmed activities will appear here.</div>
      )}
      <div className="section-heading progress-section">
        <div>
          <h2>Season history</h2>
          <p>Completed seasons are archived and never reset permanent EXP.</p>
        </div>
      </div>
      {seasonHistory.length ? (
        <div className="panel xp-transaction-list">
          {seasonHistory.map((item) => (
            <div className="xp-transaction-row" key={item.key}>
              <span className="xp-transaction-icon season-history-icon"><Flame size={16} /></span>
              <span className="xp-transaction-copy">
                <b>{item.name} · {item.progress.rank}</b>
                <small>{formatDate(item.startsAt)} – {formatDate(item.endsAt)}</small>
              </span>
              <strong>{item.progress.totalXp.toLocaleString()} XP · Lv {item.progress.level}</strong>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel progress-empty-state">No completed seasons to show yet.</div>
      )}
    </>
  );
}
function Milestone({
  icon,
  name,
  detail,
  progress,
  max,
}: {
  icon: React.ReactNode;
  name: string;
  detail: string;
  progress: number;
  max: number;
}) {
  return (
    <div className="panel milestone-card">
      <div className="milestone-icon">{icon}</div>
      <div className="milestone-copy">
        <b>{name}</b>
        <span>{detail}</span>
        <div className="milestone-track">
          <i style={{ width: `${(progress / max) * 100}%` }} />
        </div>
        <small>
          {progress.toLocaleString()} / {max.toLocaleString()}
        </small>
      </div>
      {progress >= max && (
        <div className="earned-check">
          <Check size={14} />
        </div>
      )}
    </div>
  );
}

type ImportDraft = ScreenshotDraft;
type OcrWorkflowStatus = "idle" | "loading" | "recognizing" | "success" | "partial" | "failed" | "manual";
const fieldLabels: Record<string, string> = {
  type: "activity type", date: "activity date", time: "start time", duration: "duration", distance: "distance", sourceApp: "source app",
  pace: "average pace", heartRate: "average heart rate",
};
function dateTimeTimeIsFuture(value: Date) { return value.getTime() > Date.now(); }
function uuidFromHex(hex: string) {
  const raw = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
  return raw;
}
function findPossibleDuplicate(items: Activity[], draft: ImportDraft, dateTime: Date): Activity | null {
  const type = draft.type.toLowerCase();
  const distance = parseLocalizedNumber(draft.distance);
  const duration = parseLocalizedNumber(draft.duration);
  if (distance === undefined || duration === undefined) return null;
  const localDay = `${dateTime.getFullYear()}-${dateTime.getMonth()}-${dateTime.getDate()}`;
  return items.find((item) => {
    if (item.type.toLowerCase() !== type || item.distance === undefined) return false;
    const existingDate = new Date(item.date);
    const existingDay = `${existingDate.getFullYear()}-${existingDate.getMonth()}-${existingDate.getDate()}`;
    return existingDay === localDay
      && Math.abs(existingDate.getTime() - dateTime.getTime()) <= 3 * 60_000
      && Math.abs(item.distance - distance) <= 0.05
      && Math.abs(item.duration - duration) <= 2;
  }) ?? null;
}
function validateAndPick(file: File | undefined, pick: (file?: File) => void, setStatus: (value: string) => void) {
  if (!file) return;
  const validationError = screenshotFileError(file);
  if (validationError) {
    setStatus(validationError);
    return;
  }
  pick(file);
}
function ImportPage({
  addActivity,
  userId,
  activities,
  heightCm,
}: {
  addActivity: (activity: Activity) => Promise<boolean>;
  userId: string | null;
  activities: Activity[];
  heightCm?: number;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [ocrState, setOcrState] = useState<OcrWorkflowStatus>("idle");
  const [ocrError, setOcrError] = useState("");
  const [ocrPhase, setOcrPhase] = useState("");
  const [status, setStatus] = useState("");
  const [ocrProgress, setOcrProgress] = useState(0);
  const [ocrConfidence, setOcrConfidence] = useState<number | null>(null);
  const [ocrRawText, setOcrRawText] = useState("");
  const [ocrLanguages, setOcrLanguages] = useState("");
  const [ocrReport, setOcrReport] = useState<ScreenshotParseReport | null>(null);
  const [possibleDuplicate, setPossibleDuplicate] = useState<Activity | null>(null);
  const [stepSource, setStepSource] = useState<"measured" | "estimated" | "manual" | null>(null);
  const stepEstimate = draft ? estimateRunningSteps({
    type: draft.type, distanceKm: parseLocalizedNumber(draft.distance), pace: draft.pace, heightCm,
    measuredSteps: stepSource === "measured" ? parseLocalizedNumber(draft.steps) : undefined,
    cadence: parseLocalizedNumber(draft.cadence ?? ""), cadenceUnit: draft.cadenceUnit,
    movingDurationMinutes: parseLocalizedNumber(draft.movingDurationMinutes ?? ""), activities,
  }) : null;
  const displayedSteps = draft ? stepSource === "measured" || stepSource === "manual" ? draft.steps : String(stepEstimate?.steps ?? draft.steps ?? "") : "";
  const effectiveStepSource = stepSource ?? (stepEstimate?.steps !== null && stepEstimate?.steps !== undefined ? "estimated" : null);
  const pickFile = (picked?: File) => {
    if (!picked) return;
    setFile(picked);
    setDraft(null);
    setStepSource(null);
    setOcrState("idle");
    setOcrError("");
    setOcrPhase("");
    setOcrConfidence(null);
    setOcrRawText("");
    setOcrLanguages("");
    setOcrReport(null);
    setPossibleDuplicate(null);
    setStatus("");
    if (preview) URL.revokeObjectURL(preview);
    setPreview(URL.createObjectURL(picked));
  };
  const analyze = async () => {
    if (!file) return;
    setAnalyzing(true);
    setDraft(null);
    setStepSource(null);
    setOcrReport(null);
    setOcrRawText("");
    setOcrConfidence(null);
    setOcrError("");
    setOcrState("loading");
    setOcrPhase("Loading OCR engine");
    setStatus("");
    try {
      const result = await recognizeScreenshot(file, (phase, progress) => {
        setOcrPhase(phase);
        setOcrState(phase === "Loading OCR engine" ? "loading" : "recognizing");
        setStatus(phase + " · " + Math.round(progress * 100) + "%");
        setOcrProgress(progress);
      });
      const parsedSteps = parseLocalizedNumber(result.draft.steps);
      const initialEstimate = estimateRunningSteps({
        type: result.draft.type, distanceKm: parseLocalizedNumber(result.draft.distance), pace: result.draft.pace,
        heightCm, measuredSteps: parsedSteps, cadence: parseLocalizedNumber(result.draft.cadence ?? ""),
        cadenceUnit: result.draft.cadenceUnit, movingDurationMinutes: parseLocalizedNumber(result.draft.movingDurationMinutes ?? ""), activities,
      });
      setStepSource(parsedSteps !== undefined ? "measured" : initialEstimate.steps !== null ? "estimated" : null);
      setDraft(result.draft);
      setOcrConfidence(result.confidence);
      setOcrRawText(result.rawText);
      setOcrLanguages(result.languages);
      setOcrReport(result.report);
      const hasRequiredFields = Boolean(result.draft.date && result.draft.time && result.draft.duration
        && (!["Running", "Cycling", "Swimming"].includes(result.draft.type) || result.draft.distance));
      const complete = hasRequiredFields && result.draft.uncertain.length === 0
        && result.confidence >= 60 && result.rawText.trim().length > 0;
      setOcrState(complete ? "success" : "partial");
      setStatus("");
    } catch (error) {
      setOcrError(error instanceof Error ? error.message : "The OCR engine could not read this image.");
      setOcrState("failed");
      setStatus("");
      setOcrRawText("");
      setOcrLanguages("");
      setOcrReport(null);
    } finally {
      setAnalyzing(false);
    }
  };
  const saveImport = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft || !file) return;
    if (!userId) {
      setStatus("Sign in first to save a screenshot activity to your account.");
      return;
    }
    const dateTimeLocal = `${draft.date}T${draft.time}`;
    const dateTime = new Date(dateTimeLocal);
    if (Number.isNaN(dateTime.getTime()) || dateTimeTimeIsFuture(dateTime)) {
      setStatus("Please enter a valid activity date and time in the past.");
      return;
    }
    const durationValue = parseLocalizedNumber(draft.duration);
    const distanceValue = parseLocalizedNumber(draft.distance);
    const calorieValue = parseLocalizedNumber(draft.calories);
    const stepsValue = effectiveStepSource === "measured" || effectiveStepSource === "manual"
      ? parseLocalizedNumber(draft.steps) : stepEstimate?.steps ?? parseLocalizedNumber(draft.steps);
    if (durationValue === undefined || durationValue <= 0 || ((draft.type === "Running" || draft.type === "Cycling" || draft.type === "Swimming") && (distanceValue === undefined || distanceValue <= 0))) {
      setStatus("Enter a valid duration and, for distance activities, a valid distance.");
      return;
    }
    const duplicate = possibleDuplicate ?? findPossibleDuplicate(activities, draft, dateTime);
    if (duplicate) {
      setPossibleDuplicate(duplicate);
      setStatus("This looks very similar to an activity already saved. Check your Activities page before importing it again.");
      return;
    }
    const canonical = [draft.type.toLowerCase(), dateTime.toISOString(), durationValue, distanceValue?.toFixed(3) ?? ""].join("|");
    const key = await fingerprintScreenshot(file, userId, canonical);
    const sourceKey = `screenshot:${key}`;
    const activity: Activity = {
      id: uuidFromHex(key.slice(0, 32)),
      type: draft.type,
      date: dateTime.toISOString(),
      duration: durationValue,
      distance: distanceValue,
      calories: calorieValue,
      steps: stepsValue,
      xp: 0,
      source: "screenshot",
      sourceKey,
      validationStatus: "user_confirmed",
      notes: [draft.sourceApp !== "Unknown" ? "Screenshot source: " + draft.sourceApp : "Screenshot import", draft.pace ? "Pace " + draft.pace : "", draft.heartRate ? "Average heart rate " + draft.heartRate + " bpm" : "",
        stepsValue !== undefined ? effectiveStepSource === "measured" ? "Steps source: measured" : effectiveStepSource === "estimated" ? "Steps source: estimated (" + (stepEstimate?.method ?? "pace") + (stepEstimate?.stepLengthMeters ? ", step length " + stepEstimate.stepLengthMeters + " m" : "") + ")" : "Steps source: manually entered" : "",
        draft.notes].filter(Boolean).join(" · ").slice(0, 500),
    };
    if (await addActivity(activity)) {
      setStatus("Activity confirmed and sent securely. MYLVL has refreshed your progression.");
      setOcrState("idle");
      setFile(null);
      setDraft(null);
      setStepSource(null);
      URL.revokeObjectURL(preview);
      setPreview("");
    }
  };
  const update = (key: keyof Omit<ImportDraft, "uncertain">, value: string) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));
  return (
    <>
      <PageHeading
        eyebrow="BRING IT ALL TOGETHER"
        title="Your effort, imported."
        detail="Connect a fitness app or bring in a screenshot."
      />
      <div className="import-layout">
        <div className="import-main">
          <section className="panel import-panel">
            <div className="import-panel-heading">
              <div>
                <div className="eyebrow">SCREENSHOT IMPORT</div>
                <h2>From screenshot to XP.</h2>
                <p>We’ll help read the details. You’re always in control.</p>
              </div>
              <div className="upload-ornament">
                <ImagePlus size={22} />
              </div>
            </div>
            {!file ? (
              <label
                className="upload-zone"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  validateAndPick(event.dataTransfer.files[0], pickFile, setStatus);
                }}
              >
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => validateAndPick(event.target.files?.[0], pickFile, setStatus)}
                />
                <div className="upload-circle">
                  <Upload size={19} />
                </div>
                <b>Drop a screenshot here</b>
                <span>
                  or <i>choose a file</i> from your device
                </span>
                <small>PNG, JPG, JPEG or WEBP · max. 15 MB</small>
              </label>
            ) : (
              <div className="selected-file">
                <div className="preview-image">
                  {preview && (
                    <img src={preview} alt="Uploaded activity screenshot" />
                  )}
                </div>
                <div className="file-info">
                  <b>{file.name}</b>
                  <span>
                    {(file.size / 1024 / 1024).toFixed(2)} MB · Ready to review
                  </span>
                  {draft && (
                    <div className="analyzed-note">
                      <Check size={13} /> {ocrState === "manual"
                        ? "Manual entry mode — enter the activity details below."
                        : ocrState === "success"
                          ? "Extraction successful — review every field before confirming."
                          : "Partial extraction — review highlighted fields or enter missing values."}
                    </div>
                  )}
                </div>
                <button
                  className="icon-button"
                  aria-label="Remove image"
                  onClick={() => {
                    setFile(null);
                    setDraft(null);
                    setOcrState("idle");
                    setOcrError("");
                    setOcrPhase("");
                    setOcrConfidence(null);
                    setOcrRawText("");
                    setOcrLanguages("");
                    setOcrReport(null);
                    URL.revokeObjectURL(preview);
                    setPreview("");
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {file && !draft && (
              <button
                className="primary-button analyze-button"
                onClick={analyze}
                disabled={analyzing}
              >
                {analyzing ? (
                  <>
                    <span className="spinner" /> {ocrPhase || "Loading OCR engine"}… {Math.round(ocrProgress * 100)}%
                  </>
                ) : (
                  <>
                    <Sparkles size={16} /> {ocrState === "failed" ? "Retry OCR" : "Analyze screenshot"}
                  </>
                )}
              </button>
            )}
            {ocrState === "failed" && (
              <div className="ocr-failure" role="alert">
                <b>OCR failed.</b> {ocrError || "The screenshot could not be analyzed."}
                {file && !draft && (
                  <button className="secondary-button" type="button" onClick={() => {
                    setDraft({ type: "Other", date: "", time: "", duration: "", distance: "", pace: "", heartRate: "", calories: "", elevation: "", steps: "", sourceApp: "Unknown", notes: "", uncertain: ["type", "date", "time", "duration", "distance", "sourceApp"] });
                    setStepSource(null);
                    setOcrState("manual");
                    setOcrError("");
                  }}>
                    Enter details manually
                  </button>
                )}
              </div>
            )}
            {ocrState === "loading" && <p className="ocr-phase" role="status">Loading OCR engine…</p>}
            {ocrState === "recognizing" && <p className="ocr-phase" role="status">Recognizing screenshot…</p>}
            {ocrState === "partial" && <p className="ocr-partial" role="status">Partial extraction — review the fields below. Missing values have not been filled in.</p>}
            {ocrState === "success" && <p className="ocr-success" role="status">Extraction successful. Review every field before confirming.</p>}
            {status && (
              <p
                className={`inline-status${status.startsWith("Activity confirmed") ? " success" : ""}`}
              >
                {status}
              </p>
            )}
            {draft && (
              <form className="import-form" onSubmit={saveImport}>
                <div className="form-heading">
                  <div>
                    <b>Review the details</b>
                    <span>Make any edits before confirming.</span>
                  </div>
                  <span className="xp-preview">Server calculates XP</span>
                </div>
                {draft.uncertain.length > 0 && <p className="ocr-warning">Please review: {draft.uncertain.map((field) => fieldLabels[field] ?? field).join(", ")}.</p>}
                {ocrConfidence !== null && <p className="ocr-confidence">Local OCR confidence: {Math.round(ocrConfidence)}% · Screenshot stays on this device.</p>}
                {ocrReport && (
                  <details className="ocr-diagnostics">
                    <summary>OCR diagnostics · {ocrReport.languageEstimate}</summary>
                    <div className="ocr-diagnostics-content">
                      <p><b>OCR languages:</b> {ocrLanguages || "English (eng) + German (deu)"}</p>
                      <p><b>Parser match score:</b> this is a label/context heuristic; the OCR engine score is shown above.</p>
                      <ul className="ocr-confidence-list">
                        {Object.entries(ocrReport.fieldConfidence).filter(([field]) => field !== "elevation").map(([field, value]) => (
                          <li key={field}><span>{fieldLabels[field] ?? field}</span><span>{value === null ? "No reliable match" : value + "%"} · {ocrReport.fieldSources[field] || "no label"}</span></li>
                        ))}
                      </ul>
                      {ocrReport.warnings.length > 0 && <><b>Warnings</b><ul>{ocrReport.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></>}
                      <b>Parsed fields</b>
                      <pre>{JSON.stringify(Object.fromEntries(Object.entries(draft).filter(([field]) => field !== "elevation")), null, 2)}</pre>
                      <b>Raw recognized text</b>
                      <pre>{ocrRawText || "No text recognized."}</pre>
                    </div>
                  </details>
                )}
                {possibleDuplicate && <p className="ocr-warning">Similar saved activity: {possibleDuplicate.type}, {possibleDuplicate.distance ?? "?"} km, {formatDate(possibleDuplicate.date)}. Duplicate import is blocked.</p>}
                <div className="form-grid">
                  <label className="field-label">
                    Activity
                    <select
                      value={draft.type}
                      onChange={(e) => update("type", e.target.value as ActivityType)}
                    >
                      {activityTypes.map((type) => (
                        <option key={type}>{type}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field-label">
                    Date
                    <input
                      type="date"
                      required
                      value={draft.date}
                      onChange={(e) => update("date", e.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    Start time
                    <input type="time" required value={draft.time} onChange={(e) => update("time", e.target.value)} />
                  </label>
                  <label className="field-label">
                    Duration (min)
                    <input
                      type="number"
                      min="1"
                      required
                      value={draft.duration}
                      onChange={(e) => update("duration", e.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    Distance (km)
                    <input
                      type="text"
                      inputMode="decimal"
                      required={draft.type === "Running" || draft.type === "Cycling" || draft.type === "Swimming"}
                      value={draft.distance}
                      onChange={(e) => update("distance", e.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    Calories
                    <input
                      type="text"
                      inputMode="decimal"
                      min="0"
                      value={draft.calories}
                      onChange={(e) => update("calories", e.target.value)}
                    />
                  </label>
                  <label className="field-label">
                    {effectiveStepSource === "measured" ? "Measured steps" : effectiveStepSource === "estimated" ? "Estimated steps" : "Steps"}
                    <input
                      type="number"
                      min="0"
                      value={displayedSteps}
                      onChange={(e) => {
                        update("steps", e.target.value);
                        if (effectiveStepSource === "estimated") setStepSource("manual");
                      }}
                    />
                    {effectiveStepSource === "estimated" && <small>Estimated only; this does not add EXP. Method: {stepEstimate?.method === "cadence" ? "cadence × moving time" : stepEstimate?.method === "personalized" ? "your verified runs" : "distance ÷ estimated step length"}{stepEstimate?.stepLengthMeters ? ` · ${stepEstimate.stepLengthMeters} m per step` : ""}.</small>}
                    {effectiveStepSource === "manual" && <small>Entered or adjusted manually; running steps add no walking EXP.</small>}
                  </label>
                  <label className="field-label">
                    Average pace
                    <input value={draft.pace} onChange={(e) => update("pace", e.target.value)} placeholder="6:30 min/km" />
                  </label>
                  <label className="field-label">
                    Average heart rate (bpm)
                    <input type="number" min="30" max="240" value={draft.heartRate} onChange={(e) => update("heartRate", e.target.value)} />
                  </label>
                  <label className="field-label">
                    Screenshot app
                    <select value={draft.sourceApp} onChange={(e) => update("sourceApp", e.target.value)}>
                      {["Unknown", "Garmin", "Strava", "Runna", "Apple Fitness / Health", "Other"].map((source) => <option key={source}>{source}</option>)}
                    </select>
                  </label>
                  <label className="field-label full-field">
                    Notes
                    <input
                      value={draft.notes}
                      onChange={(e) => update("notes", e.target.value)}
                      placeholder="Anything you’d like to remember"
                    />
                  </label>
                </div>
                <button className="primary-button confirm-import" type="submit" disabled={!userId}>
                  <Check size={16} /> {userId ? "Confirm activity" : "Sign in to confirm activity"}
                </button>
              </form>
            )}
          </section>
          <div className="privacy-note">
            <Shield size={16} />
            <span>
              <b>Your data stays yours.</b> Screenshots are only used to
              identify your activity details.
            </span>
          </div>
        </div>
        <aside className="import-side">
          <section className="panel providers-card">
            <div className="eyebrow">CONNECTED APPS</div>
            <h3>Your fitness toolkit</h3>
            <p>
              Direct connections are on the roadmap. They’re not active yet.
            </p>
            {[
              {
                name: "Apple Health",
                mark: "♥",
                sub: "iOS native bridge · planned",
              },
              { name: "Strava", mark: "⌁", sub: "Activity sync · planned" },
              {
                name: "Garmin Connect",
                mark: "◌",
                sub: "Health API · planned",
              },
            ].map((provider) => (
              <div className="provider-row" key={provider.name}>
                <span className="provider-mark">{provider.mark}</span>
                <span>
                  <b>{provider.name}</b>
                  <small>{provider.sub}</small>
                </span>
                <span className="soon-pill">COMING SOON</span>
              </div>
            ))}
          </section>
          <section className="import-tip">
            <Sparkles size={16} />
            <p>
              <b>Good to know</b>
              <br />
              Browser apps can’t read HealthKit or Health Connect directly. A
              native companion can bridge that gap later.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}

function SettingsPage({
  session,
  cloudState,
  installPrompt,
  appInstalled,
  onInstallPromptConsumed,
}: {
  session: Session | null;
  cloudState: "local" | "loading" | "ready" | "error";
  installPrompt: AppInstallPromptEvent | null;
  appInstalled: boolean;
  onInstallPromptConsumed: () => void;
}) {
  const configured = Boolean(supabase);
  const [email, setEmail] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [showInstallGuide, setShowInstallGuide] = useState(false);
  const installApp = async () => {
    if (appInstalled) return;
    if (!installPrompt) {
      setShowInstallGuide(true);
      return;
    }
    try {
      await installPrompt.prompt();
      await installPrompt.userChoice;
      onInstallPromptConsumed();
    } catch {
      setShowInstallGuide(true);
    }
  };
  const requestSignIn = async (event: FormEvent) => {
    event.preventDefault();
    if (!supabase) return;
    setAuthBusy(true);
    setAuthMessage("");
    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: window.location.origin,
          shouldCreateUser: true,
        },
      });
      setAuthMessage(
        error
          ? error.message
          : "Check your email for a secure link to create your account or sign in.",
      );
    } catch (error) {
      setAuthMessage(
        error instanceof Error ? error.message : "Could not send sign-in link.",
      );
    } finally {
      setAuthBusy(false);
    }
  };
  const signInWithGoogle = async () => {
    if (!supabase) return;
    setAuthBusy(true);
    setAuthMessage("");
    try {
      const { error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin },
      });
      if (error) setAuthMessage(error.message);
    } catch (error) {
      setAuthMessage(
        error instanceof Error ? error.message : "Could not start Google sign-in.",
      );
      setAuthBusy(false);
    }
  };
  const signOut = async () => {
    const { error } = (await supabase?.auth.signOut()) ?? {};
    setAuthMessage(error ? error.message : "You have signed out.");
  };
  const signedIn = Boolean(session);
  return (
    <>
      <PageHeading
        eyebrow="YOUR SPACE"
        title="The little details."
        detail="A few things that make mylvl yours."
        action={
          <button
            className="primary-button install-app-button"
            onClick={() => void installApp()}
            disabled={appInstalled}
          >
            {appInstalled ? <Check size={17} /> : <Download size={17} />}
            {appInstalled ? "App installed" : "Install app"}
          </button>
        }
      />
      <div className="settings-grid">
        <section className="panel settings-card account-settings">
          <div className="settings-card-icon">
            <Shield size={18} />
          </div>
          <h3>Your account</h3>
          <p>
            {configured
              ? signedIn
                ? `Cloud profile for ${session?.user.email ?? "your account"}.`
                : "Sign in securely to sync your profile and activity history."
              : "Your progress is saved in this browser for now."}
          </p>
          <div className="setting-status">
            <span className={cloudState === "ready" ? "status-online" : ""} />
            {configured
              ? signedIn
                ? cloudState === "loading"
                  ? "Loading cloud data"
                  : cloudState === "error"
                    ? "Cloud sync error"
                    : "Cloud sync active"
                : "Supabase ready"
              : "Local demo mode"}
          </div>
          {configured ? (
            signedIn ? (
              <button
                className="secondary-button"
                onClick={() => void signOut()}
              >
                Sign out <ArrowRight size={15} />
              </button>
            ) : (
              <div className="settings-auth-options">
                <button
                  className="secondary-button social-auth-button"
                  type="button"
                  disabled={authBusy}
                  onClick={() => void signInWithGoogle()}
                >
                  <span className="social-provider-mark google-mark" aria-hidden="true">G</span>
                  Continue with Google / Gmail
                  <ArrowRight size={15} />
                </button>
                <div className="auth-divider"><span>or use email</span></div>
                <form className="settings-auth-form" onSubmit={requestSignIn}>
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder="you@example.com"
                    aria-label="Email address"
                  />
                  <button className="secondary-button" type="submit" disabled={authBusy}>
                    {authBusy ? "Sending…" : "Email me a sign-in link"}
                    <ArrowRight size={15} />
                  </button>
                  <small className="auth-helper">New accounts are created when you use your email link.</small>
                  {authMessage && <small role="status">{authMessage}</small>}
                </form>
              </div>
            )
          ) : (
            <div className="setup-hint">
              Add <code>VITE_SUPABASE_URL</code> and{" "}
              <code>VITE_SUPABASE_PUBLISHABLE_KEY</code> to enable sign-in.
            </div>
          )}
        </section>
        <section className="panel settings-card">
          <div className="settings-card-icon purple-icon">
            <Zap size={18} />
          </div>
          <h3>Experience system</h3>
          <p>
            Every completed activity is rewarded using the same clear set of
            rules.
          </p>
          <div className="setting-status">
            <span className="status-online" /> XP rules are active
          </div>
          <button
            className="secondary-button"
            onClick={() => window.location.assign("/progress")}
          >
            View your progression <ArrowRight size={15} />
          </button>
        </section>
        <section className="panel settings-card">
          <div className="settings-card-icon blue-icon">
            <Shield size={18} />
          </div>
          <h3>Your data</h3>
          <p>
            {signedIn && cloudState === "ready"
              ? "Your activities and avatar are saved to your account."
              : signedIn
                ? "Your cloud account is signed in, but sync needs attention."
                : "Activity data is saved in this browser on this device."}
          </p>
          <div className="setting-status">
            <span
              className={
                signedIn && cloudState === "ready" ? "status-online" : ""
              }
            />
            {signedIn
              ? cloudState === "loading"
                ? "Syncing with Supabase"
                : cloudState === "error"
                  ? "Cloud sync needs attention"
                  : "Backed up to your account"
              : "Stored on this device"}
          </div>
          {!signedIn && (
            <button
              className="secondary-button"
              onClick={() => {
                localStorage.removeItem("mylvl-v1");
                window.location.reload();
              }}
            >
              Reset demo data <ArrowDownRight size={15} />
            </button>
          )}
        </section>
      </div>
      <div className="settings-footnote">
        mylvl is an early access prototype. Integrations are clearly marked
        until a secure provider connection is available.
      </div>
      {showInstallGuide && (
        <div
          className="modal-scrim"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setShowInstallGuide(false);
            }
          }}
        >
          <section
            className="install-help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="install-help-title"
          >
            <div className="modal-head">
              <div>
                <div className="eyebrow">TAKE MYLVL WITH YOU</div>
                <h2 id="install-help-title">Install mylvl</h2>
              </div>
              <button
                className="icon-button"
                onClick={() => setShowInstallGuide(false)}
                aria-label="Close install instructions"
              >
                <X size={18} />
              </button>
            </div>
            {isIosDevice() ? (
              <ol className="install-steps">
                <li>Open this page in Safari.</li>
                <li>Tap Share (the square with the arrow).</li>
                <li>Choose “Add to Home Screen”, then tap “Add”.</li>
              </ol>
            ) : isAndroidDevice() ? (
              <ol className="install-steps">
                <li>Open this page in Chrome.</li>
                <li>Tap ⋮, then “Install app” or “Add to Home screen”.</li>
                <li>Confirm by tapping “Install”.</li>
              </ol>
            ) : (
              <p className="install-help-copy">
                On Android, open mylvl in Chrome and choose “Install app” from
                the ⋮ menu. On iPhone or iPad, open it in Safari, tap Share,
                then “Add to Home Screen”.
              </p>
            )}
            <button
              className="primary-button install-help-done"
              onClick={() => setShowInstallGuide(false)}
            >
              Got it
            </button>
          </section>
        </div>
      )}
    </>
  );
}

function isIosDevice() {
  return (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

function isAndroidDevice() {
  return /Android/i.test(navigator.userAgent);
}

function ActivityModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (activity: Activity) => void | Promise<void>;
}) {
  const [type, setType] = useState<ActivityType>("Running");
  const [duration, setDuration] = useState("30");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [distance, setDistance] = useState("");
  const [calories, setCalories] = useState("");
  const [notes, setNotes] = useState("");
  const save = (event: FormEvent) => {
    event.preventDefault();
    void onSave({
      id: crypto.randomUUID(),
      type,
      date: new Date(`${date}T12:00:00`).toISOString(),
      duration: Number(duration),
      distance: Number(distance) || undefined,
      calories: Number(calories) || undefined,
      notes,
      xp: activityXpPreview({
        type,
        duration: Number(duration) || 0,
        distance: Number(distance) || undefined,
        source: "manual",
      }),
      source: "manual",
      validationStatus: "unverified",
    });
  };
  return (
    <div
      className="modal-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form className="activity-modal" onSubmit={save}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">A WIN WORTH LOGGING</div>
            <h2>Log an activity</h2>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>
        <p>Capture the effort. We’ll take care of the XP.</p>
        <label className="field-label">
          Activity type
          <select
            value={type}
            onChange={(e) => setType(e.target.value as ActivityType)}
          >
            {activityTypes.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <div className="form-grid">
          <label className="field-label">
            Date
            <input
              required
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
          <label className="field-label">
            Duration (min)
            <input
              required
              type="number"
              min="1"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
            />
          </label>
          <label className="field-label">
            Distance (km)
            <input
              type="number"
              min="0"
              step="0.01"
              value={distance}
              onChange={(e) => setDistance(e.target.value)}
            />
          </label>
          <label className="field-label">
            Calories
            <input
              type="number"
              min="0"
              value={calories}
              onChange={(e) => setCalories(e.target.value)}
            />
          </label>
        </div>
        <label className="field-label">
          Notes <span className="optional">OPTIONAL</span>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="How did it feel?"
          />
        </label>
        <div className="modal-reward">
          <div className="reward-icon">
            <Zap size={17} fill="currentColor" />
          </div>
          <span>
            <b>Your reward</b>
            <small>Manual logs are saved without EXP.</small>
          </span>
          <strong>
            +{activityXpPreview({
              type,
              duration: Number(duration) || 0,
              distance: Number(distance) || undefined,
              source: "manual",
            })} XP
          </strong>
        </div>
        <button className="primary-button modal-submit" type="submit">
          <Check size={16} /> Save activity
        </button>
      </form>
    </div>
  );
}

