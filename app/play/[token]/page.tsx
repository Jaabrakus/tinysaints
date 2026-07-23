import { getPublicPlaytestSnapshot, RoomError } from "../../../lib/room-service";
import PlaytestFeedback from "./PlaytestFeedback";

export const dynamic = "force-dynamic";

export default async function PublicPlaytestPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  try {
    const snapshot = await getPublicPlaytestSnapshot(token);
    return (
      <main className="public-playtest">
        <header>
          <div><span>MAKE/ROOM PLAYTEST</span><strong>{snapshot.room.name}</strong></div>
          <p>{snapshot.link.label} · immutable build v{snapshot.build.version}</p>
        </header>
        <iframe
          title={`${snapshot.build.name} public playtest`}
          src={`/api/public-play?token=${encodeURIComponent(token)}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
        />
        <PlaytestFeedback token={token} />
      </main>
    );
  } catch (error) {
    const message = error instanceof RoomError ? error.message : "This playtest is unavailable.";
    return <main className="public-playtest public-playtest--error"><strong>PLAYTEST CLOSED</strong><p>{message}</p></main>;
  }
}
