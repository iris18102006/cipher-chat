// The download helper (a service worker). It does one job: when a big file is saved in a browser
// that has no "save to disk" dialog (Firefox, Safari), the page hands the unlocked pieces to this
// worker one at a time and the worker streams them to the browser's download, so the whole file
// never has to sit in memory. That is what lifts the 1 GB limit there.
