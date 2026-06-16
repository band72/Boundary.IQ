const text = "SOUTH 89 DEGREES 41 MINUTES 10 SECONDS WEST";
const regex = /\b(N|S|NORTH|SOUTH)\s*(\d{1,3}(?:\s*DEGREES?|\s*°|\s*\-)?\s*(?:\d{1,2}\s*(?:MINUTES?|'|\s*\-))?\s*(?:\d{1,2}(?:\.\d+)?\s*(?:SECONDS?|"|\s*\-))?)\s*(E|W|EAST|WEST)\b/i;

const match = text.match(regex);
console.log('Match:', match);
