// Planted bugs for an end-to-end samorev CLI verification (throwaway).
export async function getUser(db: any, id: string) {
  const sql = "SELECT * FROM users WHERE id = '" + id + "'";  // SQL injection
  return (await db.query(sql)).rows[0];
}
export function pageItems(items: any[], page: number) {
  const start = page * 10;
  const end = start + 10;
  return items.slice(start, end + 1);   // off-by-one: 11 per page
}
