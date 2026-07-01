// restore.js
// Non-destructive restore. Reads a backup file the user selected, decompresses,
// validates it looks like a bookmark tree, and recreates it inside a NEW folder
// under "Other Bookmarks". It never deletes, moves, or overwrites anything.

import { decompress, formatFromFilename } from "./compression.js";

// Read a File object's bytes as a Uint8Array.
function readFileBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result));
    reader.onerror = () => reject(reader.error || new Error("Could not read file."));
    reader.readAsArrayBuffer(file);
  });
}

// Parse + validate a backup File. Returns { tree, counts: { folders, bookmarks } }.
// Throws a clear error if the file is not a valid bookmark backup.
export async function loadBackupFile(file) {
  const format = formatFromFilename(file.name);
  const bytes = await readFileBytes(file);

  // decompress() throws a clear message when zstd support is missing; let it bubble.
  const json = await decompress(bytes, format);

  let tree;
  try {
    tree = JSON.parse(json);
  } catch {
    throw new Error("File did not contain valid JSON.");
  }

  // Validate: chrome.bookmarks.getTree() returns an array whose first element is
  // a root node with a children array.
  if (!Array.isArray(tree) || tree.length === 0 || !Array.isArray(tree[0].children)) {
    throw new Error("File does not look like a bookmark backup.");
  }

  const counts = countNodes(tree);
  return { tree, counts };
}

// Count folders and bookmarks in a parsed tree (for the confirmation summary).
export function countNodes(nodes) {
  let folders = 0;
  let bookmarks = 0;

  const walk = (list) => {
    for (const node of list) {
      if (node.url) {
        bookmarks++;
      } else if (Array.isArray(node.children)) {
        folders++;
        walk(node.children);
      }
    }
  };

  // The top level is the invisible root node(s); descend into their children so
  // we don't count the root itself as a folder.
  for (const root of nodes) {
    if (Array.isArray(root.children)) walk(root.children);
  }
  return { folders, bookmarks };
}

// Recreate the tree under a new timestamped folder in "Other Bookmarks" (id "2").
// Returns the id of the new top-level restore folder.
export async function restoreTree(tree, isoTimestamp) {
  const restoreFolder = await chrome.bookmarks.create({
    parentId: "2", // "Other Bookmarks"
    title: `Bookmarks Restore ${isoTimestamp}`,
  });

  // Recreate each root's children inside the new folder.
  for (const root of tree) {
    if (Array.isArray(root.children)) {
      await createChildren(root.children, restoreFolder.id);
    }
  }
  return restoreFolder.id;
}

// Recursively create nodes under parentId, preserving order.
async function createChildren(children, parentId) {
  for (const node of children) {
    if (node.url) {
      // A bookmark: create it with its title and url.
      await chrome.bookmarks.create({ parentId, title: node.title || "", url: node.url });
    } else if (Array.isArray(node.children)) {
      // A folder: create it, then recurse into its children.
      const folder = await chrome.bookmarks.create({ parentId, title: node.title || "" });
      await createChildren(node.children, folder.id);
    }
  }
}
