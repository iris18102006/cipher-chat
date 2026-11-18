// Saving a big file in browsers that have no "save to disk" dialog (Firefox, Safari): the unlocked
// pieces are streamed through the download helper in web/sw.js, so the file never has to fit in
// memory. Chrome and Edge don't need this, they write straight to disk. If anything here is
// missing or fails before the first piece, attachments.js falls back to the old way.

