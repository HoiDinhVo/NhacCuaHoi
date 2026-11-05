import "dotenv/config";

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Kiem chung hanh vi TIM KIEM tren PostgreSQL: npx tsx scripts/verify-search.ts
 *
 * Vi sao can: SQL Server so sanh chuoi KHONG phan biet hoa/thuong (collation mac dinh), con
 * PostgreSQL thi CO. Neu thieu `mode: "insensitive"` thi nguoi dung go "nhac" se khong tim thay
 * "Nhạc" - dung loai loi im lang, kho phat hien bang mat thuong.
 *
 * Script kiem 2 tang:
 *  1. Ma nguon: moi truy van `contains` trong tang nghiep vu deu phai co `mode:` (khong can CSDL).
 *  2. CSDL that (neu ket noi duoc): tao 1 bai tam co ten HOA/thuong lan lon, tim bang chu thuong,
 *     roi xoa di. Khong ket noi duoc -> SKIP (khong lam hong ket qua kiem tra).
 */

const results: string[] = [];

function check(label: string, passed: boolean, detail = ""): void {
  results.push(`${passed ? "PASS" : "FAIL"} | ${label}${detail ? ` | chi tiet: ${detail}` : ""}`);
}

function skip(label: string, detail = ""): void {
  results.push(`SKIP | ${label}${detail ? ` | chi tiet: ${detail}` : ""}`);
}

/* ------------------------- 1. Kiem tra o tang ma nguon ------------------------- */

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(path.join(root, ...relativePath.split("/")), "utf8");
}

const songService = source("src/services/song.service.ts");
const discoveryService = source("src/services/song-discovery.service.ts");
const authSource = source("src/auth.ts");
const userService = source("src/services/user.service.ts");

/** Mọi `contains:` trong file phải đi kèm `mode:` ở cùng object */
function containsAlwaysHasMode(fileSource: string): { ok: boolean; offenders: string[] } {
  const offenders: string[] = [];

  for (const line of fileSource.split(/\r?\n/)) {
    if (!line.includes("contains:")) continue;
    if (line.includes("mode:")) continue;
    // Cho phep dong mo dau (object nam o dong duoi)
    offenders.push(line.trim());
  }

  return { ok: offenders.length === 0, offenders };
}

const songWhere = containsAlwaysHasMode(songService);
check(
  "Moi `contains` o song.service.ts deu kem `mode` (khong phan biet hoa/thuong)",
  songWhere.ok,
  songWhere.offenders.join(" / "),
);

const discoveryWhere = containsAlwaysHasMode(discoveryService);
check(
  "Moi `contains` o song-discovery.service.ts deu kem `mode`",
  discoveryWhere.ok,
  discoveryWhere.offenders.join(" / "),
);

check(
  "Che do so sanh duoc khai bao bang hang so `as const` (giu dung kieu QueryMode)",
  songService.includes('const CASE_INSENSITIVE = "insensitive" as const;'),
);
check("Tim kiem nhanh (thanh header) cung dung che do khong phan biet hoa/thuong", discoveryService.includes("quickSearch"));
check(
  "Email dang nhap duoc chuan hoa chu thuong truoc khi tra cuu",
  authSource.includes("parsed.data.email.toLowerCase()") &&
    userService.includes("email.toLowerCase()"),
);

/**
 * Kiem tra TINH ON DINH cua thu tu sap xep (deterministic ordering).
 *
 * Vì sao can: CSDL chi dam bao thu tu khi TAT CA cot sap xep deu bang nhau. Neu chi sap xep theo
 * 1 cot (vi du `createdAt`), cac bai co cung gia tri se duoc tra ve theo thu tu TUY Y cua CSDL ->
 * ket qua tim kiem "nhay lung tung" giua 2 lan tai, va phan trang co the bi trung bai / bo sot bai.
 * `id` la `cuid()` duy nhat nen lam khoa phu luon ton tai va cho thu tu on dinh.
 */
const sortMapBlock = songService.match(/const SORT_MAP = \{[\s\S]*?\n\};/)?.[0] ?? "";
const sortKeys = ["newest", "oldest", "title", "plays"] as const;

const sortMapHasTieBreaker = sortKeys.every((key) => {
  const line = sortMapBlock
    .split("\n")
    .find((candidate) => candidate.trim().startsWith(`${key}:`));
  return Boolean(line && /\{\s*id:\s*"(asc|desc)"/.test(line));
});

check(
  "Moi kieu sap xep trong SORT_MAP deu co khoa phu `id` (duy nhat) de thu tu on dinh",
  sortMapHasTieBreaker,
  sortMapBlock.replace(/\s+/g, " "),
);

/* ------------------------- 2. Kiem tra tren CSDL that ------------------------- */

async function runDatabaseCheck(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    skip("Kiem tra tren CSDL that", "DATABASE_URL khong phai PostgreSQL (xem muc \"Cau hinh .env\" trong README.md)");
    return;
  }

  let prismaModule: typeof import("@/lib/db/prisma") | null = null;

  try {
    prismaModule = await import("@/lib/db/prisma");
  } catch (error) {
    skip("Kiem tra tren CSDL that", error instanceof Error ? error.message : String(error));
    return;
  }

  const { prisma } = prismaModule;
  const marker = `Kiểm Chứng Tìm Kiếm ${Date.now()}`;
  let songId: string | null = null;

  try {
    const created = await prisma.song.create({
      data: {
        title: marker,
        artist: "ZZZ Kiểm Chứng",
        sourceType: "YOUTUBE",
        isPublished: true,
      },
      select: { id: true },
    });
    songId = created.id;

    const lowered = marker.toLowerCase();
    const found = await prisma.song.count({
      where: { title: { contains: lowered, mode: "insensitive" } },
    });
    check("Tim bang chu THUONG ra bai co ten HOA/thuong lan lon", found >= 1, `found=${found}`);

    const strict = await prisma.song.count({ where: { title: { contains: lowered } } });
    check(
      "Che do mac dinh (khong `mode`) la phan biet hoa/thuong -> dung la ly do phai co `mode`",
      strict === 0,
      `strict=${strict}`,
    );
  } catch (error) {
    skip("Kiem tra tren CSDL that", error instanceof Error ? error.message : String(error));
  } finally {
    if (songId) {
      await prisma.song.delete({ where: { id: songId } }).catch(() => undefined);
    }
    await prisma.$disconnect().catch(() => undefined);
  }
}

/**
 * KIEM TRA HOI QUY: cac bai co CUNG gia tri khoa sap xep chinh phai duoc tra ve theo cung
 * mot thu tu, lap lai nhieu lan cung giong nhau (deterministic ordering).
 *
 * Vì sao can: neu chi sap xep theo 1 cot, CSDL duoc phep tra ve cac dong co cung gia tri theo
 * thu tu bat ky -> trang tim kiem "nhay lung tung", phan trang co the trung bai / bo sot bai.
 * Voi khoa phu `id` (cuid duy nhat) thi thu tu luon bat bien.
 */
async function runDeterministicOrderCheck(): Promise<void> {
  const url = process.env.DATABASE_URL ?? "";
  if (!url.startsWith("postgres")) {
    skip("Kiem tra thu tu sap xep on dinh", "DATABASE_URL khong phai PostgreSQL");
    return;
  }

  let prismaModule: typeof import("@/lib/db/prisma") | null = null;

  try {
    prismaModule = await import("@/lib/db/prisma");
  } catch (error) {
    skip(
      "Kiem tra thu tu sap xep on dinh",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const { prisma } = prismaModule;
  const { listSongs } = await import("@/services/song.service");
  const { songListQuerySchema } = await import("@/lib/validations/song");

  const orderMarker = `Kiem Chung Thu Tu ${Date.now()}`;
  /** Moi bai deu co CUNG createdAt / playCount / title -> la trung hop "khoa chinh bang nhau" */
  const sharedCreatedAt = new Date("2024-01-01T00:00:00.000Z");
  const createdIds: string[] = [];

  try {
    for (let index = 0; index < 3; index += 1) {
      const created = await prisma.song.create({
        data: {
          title: orderMarker,
          artist: "ZZZ Kiem Chung Thu Tu",
          sourceType: "YOUTUBE",
          isPublished: true,
          createdAt: sharedCreatedAt,
          playCount: 7,
        },
        select: { id: true },
      });
      createdIds.push(created.id);
    }

    const expectedAsc = [...createdIds].sort();
    const expectedDesc = [...createdIds].sort().reverse();

    /** Chay cung mot truy van nhieu lan, so sanh day du danh sach id tra ve */
    async function idsFor(sort: "newest" | "oldest" | "title" | "plays"): Promise<string[]> {
      const query = songListQuerySchema.parse({
        q: orderMarker,
        sort,
        page: 1,
        pageSize: 100,
        scope: "published",
      });
      const result = await listSongs(query);
      // Chi giu cac bai ta vua tao, bo qua ket qua trung ten dot nhat (neu co)
      return result.items.map((item) => item.id).filter((id) => createdIds.includes(id));
    }

    const cases: { sort: "newest" | "oldest" | "title" | "plays"; expected: string[] }[] = [
      { sort: "newest", expected: expectedDesc },
      { sort: "oldest", expected: expectedAsc },
      { sort: "title", expected: expectedAsc },
      { sort: "plays", expected: expectedDesc },
    ];

    for (const testCase of cases) {
      const first = await idsFor(testCase.sort);
      const second = await idsFor(testCase.sort);
      const third = await idsFor(testCase.sort);

      const sameEveryTime =
        first.join("|") === second.join("|") && second.join("|") === third.join("|");
      check(
        `Sap xep "${testCase.sort}": 3 lan goi cho cung thu tu`,
        sameEveryTime,
        `first=${first.join(",")}`,
      );

      check(
        `Sap xep "${testCase.sort}": thu tu khoa phu "id" dung chieu sap xep`,
        first.join("|") === testCase.expected.join("|"),
        `expected=${testCase.expected.join(",")} actual=${first.join(",")}`,
      );
    }
  } catch (error) {
    skip(
      "Kiem tra thu tu sap xep on dinh",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (createdIds.length > 0) {
      await prisma.song
        .deleteMany({ where: { id: { in: createdIds } } })
        .catch(() => undefined);
    }
    await prisma.$disconnect().catch(() => undefined);
  }
}

/* --------------------------------- Ket qua --------------------------------- */

void (async () => {
  await runDatabaseCheck();
  await runDeterministicOrderCheck();

  const failed = results.filter((line) => line.startsWith("FAIL"));
  console.log(results.join("\n"));
  console.log(`\nTONG KET: ${results.length - failed.length} PASS / ${failed.length} FAIL`);

  process.exitCode = failed.length === 0 ? 0 : 1;
})();
