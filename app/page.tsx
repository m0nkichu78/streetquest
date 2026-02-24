import Link from "next/link";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-[#0a0a0a] px-4">
      <div className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-6xl font-bold tracking-tight text-white sm:text-7xl">
          StreetQuest
        </h1>
        <p className="text-lg text-zinc-400 sm:text-xl">
          Explore ta ville, rue par rue
        </p>
        <Link
          href="/map"
          className="mt-4 rounded-full border border-zinc-700 bg-zinc-900 px-8 py-3 text-sm font-medium text-zinc-100 transition-colors hover:border-zinc-500 hover:bg-zinc-800"
        >
          Choisir une ville
        </Link>
      </div>
    </main>
  );
}
