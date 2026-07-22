import { chatGPTSignOutPath, requireChatGPTUser } from "./chatgpt-auth";
import RoomClient from "./RoomClient";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ room?: string | string[] }>;
}) {
  const user = await requireChatGPTUser("/");
  const requestedRoom = (await searchParams).room;
  const initialSlug = Array.isArray(requestedRoom) ? requestedRoom[0] : requestedRoom;
  return (
    <RoomClient
      key={initialSlug || "home"}
      initialUser={{ displayName: user.displayName }}
      initialSlug={initialSlug ?? ""}
      signOutPath={chatGPTSignOutPath("/")}
    />
  );
}
