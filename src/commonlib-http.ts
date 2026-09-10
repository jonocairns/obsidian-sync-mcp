/** Build the document endpoint used for complete CouchDB conflict snapshots. */
export function couchdbDocumentUrl(baseUrl: string, database: string, id: string): string {
    const base = new URL(baseUrl);
    // Node fetch rejects URL userinfo. Authentication is supplied separately
    // from the explicit options, matching PouchDB's auth precedence.
    base.username = "";
    base.password = "";
    return `${base.toString().replace(/\/+$/, "")}/${encodeURIComponent(database)}/${encodeURIComponent(id)}`;
}
