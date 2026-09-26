// The classic modem intro banner — a stylised combining-mark ("zalgo")
// slogan ("MODEM VAS PREKO RADIA PRIKLJAPLJA NA MEDMREŽJE...") that used to
// open the radioštudent post itself, verified against a real live page
// (fetched https://radiostudent.si/glasba/modem/modem-247 directly, not
// retyped — combining marks are exactly the kind of text a manual
// transcription silently corrupts). The archive site's own cleanBody()
// (scripts/scrape-modem.js) already strips a combining-mark <p> like this
// one on sight (no iframe, no slash run, no artist/label link) — so this
// shows on the raw radioštudent page but not the mirrored archive, same
// as it already does for the ~58 older shows that still carry it.
const INTRO_BANNER_TEXT = "M͕ODE͍̣M̫ ̝̳̼͖͕͕̘V͉̭̗͖͈̝A̙Sͅ ̦̗̱̩̪̟ͅP̮̗͍R͕̼̲͍E̖K̫̯͈͈̥ͅO͔ ͙̯R̻̙̙̟A͇̼̞͚͓̗̰D̠̙͓I̠͇A̤͕̙̘͈͖ͅ ̣̜̤͓̫̮P͇̰̻̠RI̪̦̟̩̞͇K͔̭̙͍͕̻̦L͍̠̟͕̲̪A͙̘̮̜̼P̙̦̺̳L̲J̙̫̠A̬̙͇̣͇ ͈̼̣͍̲̥N̼A ͇̱͉̻M̰̺͖̠̥E̲̱̩̘̳͚D̟̱̰̻̳͚̼M̻͇̲R̳̼E̞̱̝͈̰̮Ž͕͕͉̩̩J̤E̹͙̺̫,̪̤̫̭͓̝ ̖̩̙KJ̹̝̬̣͙͉E͔R̻͚̟̹ V͎̞̟AS̱ ͎̣̗̤͉͎V̜͇̥͚͚̜̘O̞̬̖̟̻̬͍D͓͎̣̺Ḭ͈̪̯͓ ̼̫̺̟͎S̤KO̯̠Z̪I̪̤̹͇ ̻̘ͅP͈̞̜̳̮RE̤̩̘͇Z̗͚̣̮R̠T̻͓̘̪E̖̮̣̭̦͈ ͙̻͈̺P̰͖̼̫̙R̰̺Ẹ̰͚D͖͈̤͓̻E̱̮ḺͅE ͙̞̠S͉ͅP̘L͚̯̟E̥̱̟͎T͕̪̙̙̮̳N̬̲̼̟͎Ẹ̘̺̖̰̞ͅG̞̟͍̜A̗̜̙ P̲̬͉̻̮͓̳O͚͙̠̭D̼̦̟̘T͎̭̰̤͎ALJ͙͎̤̤̩A̼̰,͕͚̗̻ ̳O̗͚B̥͉E̺͓̗̖͙N̲̜̜̤̯͇̦E͎̮ͅM͇̘̼ ̤͉̖̹PA̟̭̳̝̝ ̥̤͖R̬̤̮͇A͙͚Z͖̗̹̰IS͖̺̥K͈͚̲U̬͚̪̼J̜̬̺̲̖E̘̯,̲ ̫͇A͕̣͚͉͈N̦̳̰A̞̝̞̼L͍I̫̥͉Z͈̠IR̩͚͈̗Aͅ ̭̳̯I̙̫̫͈̤̰N͙̞ ̝̩͇PR͓̳E͈̠̰̱̺̱͚D̬̹̯̝ͅV̱̞̟̞S͈̻̜ͅEM̺̖ ̼̤̥̥͈͉͕UŽ͍̗I̥̤͎V͕̭A N̗̮̺̟͈̟Ạ͖͍̼J̤͓̻̥̼̟͕N̮̗͈̻̪͉̦O̼̲̺̯̮̮ͅV͔̮̭̗͍̥̳E͎̺̻͙͕͍̜J̝̰̻͎Š̝̣̜̟̖ͅE̙̠̪͍͇͕ ͕̤͈͎̘͙̪O̮̼̘͖D͖VO͎̪̦͇̟D̪̝̠̪̞̩̻Ẹ̖̗̣̠̰ ̦̘S̙̰̦O̱̰̬D̫͍̯O͔͔B̘͙̦͖̤̘N͍Ḙ̲̳̠ ̗̣͖̭E̯̠L̮̥̬̩̮̞̫E̱͖͇K͕̯̺̠͍͈ͅT̥R̩̥ONS̤͈̣̖͇̗K̙̜̙ͅE̬̥̟̰̱ G̝͓̲͓̻L̝͇̰̭̟̖̘A̠̰̠̯͇S̱̖̫B̯̣̙E͈̤̟̯̞̤̻.̥͖̗̞͕̫̞ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~";
module.exports = { INTRO_BANNER_TEXT };
