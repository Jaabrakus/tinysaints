import { chatGPTSignOutPath } from "./chatgpt-auth";
import { getIdentity } from "../lib/room-service";
import GuestEntry from "./GuestEntry";
import RoomClient from "./RoomClient";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ room?: string | string[] }>;
}) {
  const requestedRoom = (await searchParams).room;
  const initialSlug = Array.isArray(requestedRoom) ? requestedRoom[0] : requestedRoom;
  const identity = await getIdentity();
  if (!identity) return <GuestEntry requestedRoom={initialSlug ?? ""} />;
  return (
    <RoomClient
      key={initialSlug || "home"}
      initialUser={{ displayName: identity.displayName }}
      initialSlug={initialSlug ?? ""}
      signOutPath={identity.id.startsWith("gst_") ? "/api/guest?logout=1" : chatGPTSignOutPath("/")}
    />
  );
}
