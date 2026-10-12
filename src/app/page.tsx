import { redirect } from "next/navigation";
import { isEditor } from "@/lib/auth/editor";

export default async function Home() {
  redirect((await isEditor()) ? "/dashboard" : "/unlock");
}
