const EVENTS = [
  { id: 1, name: "Super Bowl LX", performer: "NFL", date: "Feb 8, 2026", venue: "Levi's Stadium", city: "Santa Clara, CA", price: 4500, category: "sports", subcategory: "NFL", image: "https://picsum.photos/seed/superbowl/520/325" },
  { id: 2, name: "NBA Finals - Game 5", performer: "NBA", date: "Jun 18, 2026", venue: "Madison Square Garden", city: "New York, NY", price: 890, category: "sports", subcategory: "NBA", image: "https://picsum.photos/seed/nba2026/520/325" },
  { id: 3, name: "World Series - Game 7", performer: "MLB", date: "Oct 31, 2026", venue: "Dodger Stadium", city: "Los Angeles, CA", price: 1200, category: "sports", subcategory: "MLB", image: "https://picsum.photos/seed/worldseries/520/325" },
  { id: 4, name: "Stanley Cup Finals", performer: "NHL", date: "Jun 15, 2026", venue: "TD Garden", city: "Boston, MA", price: 750, category: "sports", subcategory: "NHL", image: "https://picsum.photos/seed/stanleycup/520/325" },
  { id: 5, name: "NFL Kickoff Game", performer: "Kansas City Chiefs vs Baltimore Ravens", date: "Sep 10, 2026", venue: "Arrowhead Stadium", city: "Kansas City, MO", price: 320, category: "sports", subcategory: "NFL", image: "https://picsum.photos/seed/nflkickoff/520/325" },
  { id: 6, name: "NCAA Championship", performer: "College Football", date: "Jan 11, 2027", venue: "Mercedes-Benz Stadium", city: "Atlanta, GA", price: 680, category: "sports", subcategory: "NCAAF", image: "https://picsum.photos/seed/ncaa/520/325" },
  { id: 7, name: "Beyonce - Renaissance World Tour", performer: "Beyonce", date: "Jul 20, 2026", venue: "SoFi Stadium", city: "Los Angeles, CA", price: 295, category: "concerts", subcategory: "Pop", image: "https://picsum.photos/seed/beyonce/520/325" },
  { id: 8, name: "Taylor Swift - Eras Tour", performer: "Taylor Swift", date: "Aug 15, 2026", venue: "MetLife Stadium", city: "East Rutherford, NJ", price: 450, category: "concerts", subcategory: "Pop", image: "https://picsum.photos/seed/taylor/520/325" },
  { id: 9, name: "Coldplay - Music of the Spheres", performer: "Coldplay", date: "Sep 5, 2026", venue: "Rose Bowl", city: "Pasadena, CA", price: 180, category: "concerts", subcategory: "Rock", image: "https://picsum.photos/seed/coldplay/520/325" },
  { id: 10, name: "Drake - It's All a Blur Tour", performer: "Drake", date: "Oct 12, 2026", venue: "United Center", city: "Chicago, IL", price: 225, category: "concerts", subcategory: "Rap", image: "https://picsum.photos/seed/drake/520/325" },
  { id: 11, name: "Ed Sheeran - Mathematics Tour", performer: "Ed Sheeran", date: "Nov 8, 2026", venue: "Wembley Stadium", city: "London, UK", price: 165, category: "concerts", subcategory: "Pop", image: "https://picsum.photos/seed/edsheeran/520/325" },
  { id: 12, name: "The Weeknd - After Hours Til Dawn", performer: "The Weeknd", date: "Dec 1, 2026", venue: "AT&T Stadium", city: "Arlington, TX", price: 210, category: "concerts", subcategory: "R&B", image: "https://picsum.photos/seed/weeknd/520/325" },
  { id: 13, name: "Coachella 2026", performer: "Various Artists", date: "Apr 10, 2026", venue: "Empire Polo Club", city: "Indio, CA", price: 599, category: "concerts", subcategory: "Festival", image: "https://picsum.photos/seed/coachella/520/325" },
  { id: 14, name: "Rolling Loud 2026", performer: "Various Artists", date: "Jul 25, 2026", venue: "Hard Rock Stadium", city: "Miami, FL", price: 399, category: "concerts", subcategory: "Festival", image: "https://picsum.photos/seed/rollingloud/520/325" },
  { id: 15, name: "Hamilton", performer: "Broadway Company", date: "Running through Dec 2026", venue: "Richard Rodgers Theatre", city: "New York, NY", price: 249, category: "theater", subcategory: "Musicals", image: "https://picsum.photos/seed/hamilton/520/325" },
  { id: 16, name: "The Lion King", performer: "Broadway Company", date: "Running through Jan 2027", venue: "Minskoff Theatre", city: "New York, NY", price: 189, category: "theater", subcategory: "Musicals", image: "https://picsum.photos/seed/lionking/520/325" },
  { id: 17, name: "Wicked", performer: "Broadway Company", date: "Running through Mar 2027", venue: "Gershwin Theatre", city: "New York, NY", price: 215, category: "theater", subcategory: "Musicals", image: "https://picsum.photos/seed/wicked/520/325" },
  { id: 18, name: "Comedy Cellar Live", performer: "Various Comedians", date: "Every Fri-Sat", venue: "Comedy Cellar", city: "New York, NY", price: 35, category: "comedy", subcategory: "Comedy", image: "https://picsum.photos/seed/comedy/520/325" },
  { id: 19, name: "Kevin Hart - Reality Check", performer: "Kevin Hart", date: "Nov 22, 2026", venue: "Chase Center", city: "San Francisco, CA", price: 95, category: "comedy", subcategory: "Comedy", image: "https://picsum.photos/seed/kevinhart/520/325" },
  { id: 20, name: "Dallas Cowboys vs NY Giants", performer: "Dallas Cowboys vs New York Giants", date: "Sep 14, 2026", venue: "AT&T Stadium", city: "Arlington, TX", price: 175, category: "sports", subcategory: "NFL", image: "https://picsum.photos/seed/cowboys/520/325" },
  { id: 21, name: "LA Lakers vs Boston Celtics", performer: "Los Angeles Lakers vs Boston Celtics", date: "Dec 25, 2026", venue: "Crypto.com Arena", city: "Los Angeles, CA", price: 420, category: "sports", subcategory: "NBA", image: "https://picsum.photos/seed/lakers/520/325" },
  { id: 22, name: "NY Yankees vs Boston Red Sox", performer: "New York Yankees vs Boston Red Sox", date: "Jul 4, 2026", venue: "Yankee Stadium", city: "Bronx, NY", price: 285, category: "sports", subcategory: "MLB", image: "https://picsum.photos/seed/yankees/520/325" },
  { id: 23, name: "Adele - Las Vegas Residency", performer: "Adele", date: "Oct 30, 2026", venue: "The Colosseum at Caesars Palace", city: "Las Vegas, NV", price: 350, category: "concerts", subcategory: "Pop", image: "https://picsum.photos/seed/adele/520/325" },
  { id: 24, name: "Hamilton - Chicago", performer: "Broadway Company", date: "Running through Nov 2026", venue: "CIBC Theatre", city: "Chicago, IL", price: 179, category: "theater", subcategory: "Musicals", image: "https://picsum.photos/seed/hamilton2/520/325" },
  { id: 25, name: "World Cup 2026 - Final", performer: "FIFA World Cup", date: "Jul 19, 2026", venue: "MetLife Stadium", city: "East Rutherford, NJ", price: 3500, category: "sports", subcategory: "Soccer", image: "https://picsum.photos/seed/worldcup/520/325" },
  { id: 26, name: "Formula 1 - US Grand Prix", performer: "F1", date: "Oct 18, 2026", venue: "Circuit of the Americas", city: "Austin, TX", price: 425, category: "sports", subcategory: "Motorsports", image: "https://picsum.photos/seed/f1/520/325" },
  { id: 27, name: "Post Malone - F1 Trillion Tour", performer: "Post Malone", date: "Aug 28, 2026", venue: "Madison Square Garden", city: "New York, NY", price: 195, category: "concerts", subcategory: "Pop", image: "https://picsum.photos/seed/postmalone/520/325" },
  { id: 28, name: "Bad Bunny - Most Wanted Tour", performer: "Bad Bunny", date: "Sep 20, 2026", venue: "Kaseya Center", city: "Miami, FL", price: 275, category: "concerts", subcategory: "Latin", image: "https://picsum.photos/seed/badbunny/520/325" },
];

const CATEGORIES = {
  sports: {
    name: "Sports",
    color: "#1a56db",
    image: "https://picsum.photos/seed/sportscat/800/450",
    subcategories: [
      { name: "NFL", url: "#" },
      { name: "NBA", url: "#" },
      { name: "MLB", url: "#" },
      { name: "NHL", url: "#" },
      { name: "NCAA Football", url: "#" },
      { name: "Motorsports", url: "#" },
      { name: "Soccer", url: "#" }
    ]
  },
  concerts: {
    name: "Concerts",
    color: "#7c3aed",
    image: "https://picsum.photos/seed/concertscat/800/450",
    subcategories: [
      { name: "Pop", url: "#" },
      { name: "Rock", url: "#" },
      { name: "Rap & Hip-Hop", url: "#" },
      { name: "Country & Folk", url: "#" },
      { name: "R&B", url: "#" },
      { name: "Festivals", url: "#" },
      { name: "Latin", url: "#" }
    ]
  },
  theater: {
    name: "Theater & Arts",
    color: "#dc2626",
    image: "https://picsum.photos/seed/theatercat/800/450",
    subcategories: [
      { name: "Musicals", url: "#" },
      { name: "Broadway Shows", url: "#" },
      { name: "Plays", url: "#" },
      { name: "Opera", url: "#" },
      { name: "Dance", url: "#" }
    ]
  },
  comedy: {
    name: "Comedy",
    color: "#ea580c",
    image: "https://picsum.photos/seed/comedycat/800/450",
    subcategories: [
      { name: "Stand-up", url: "#" },
      { name: "Matt Rife Tickets", url: "matt-rife.html" },
      { name: "Improv", url: "#" },
      { name: "Comedy Shows", url: "#" }
    ]
  }
};

const MY_TICKETS = [
  { id: 1, eventId: 8, orderId: "SH-20260815-4821", section: "Floor / Pit", row: "A", seats: "12-13", quantity: 2, delivery: "Mobile Entry", price: 450, boughtOn: "Mar 2, 2026", status: "upcoming" },
  { id: 2, eventId: 21, orderId: "SH-20261225-1093", section: "Lower Level", row: "12", seats: "5-6", quantity: 2, delivery: "Mobile Entry", price: 420, boughtOn: "May 18, 2026", status: "upcoming" },
  { id: 3, eventId: 13, orderId: "SH-20260410-7712", section: "General Admission", row: "GA", seats: "Weekend pass", quantity: 1, delivery: "E-Ticket", price: 599, boughtOn: "Jan 12, 2026", status: "upcoming" },
  { id: 4, eventId: 17, orderId: "SH-20261130-2388", section: "Orchestra", row: "M", seats: "21-22", quantity: 2, delivery: "Mobile Entry", price: 215, boughtOn: "Feb 27, 2026", status: "upcoming" },
  { id: 5, eventId: 2, orderId: "SH-20260618-5510", section: "Club Level", row: "CL1", seats: "7-8", quantity: 2, delivery: "Mobile Entry", price: 890, boughtOn: "Apr 9, 2026", status: "upcoming" },
  { id: 6, eventId: 19, orderId: "SH-20251122-8834", section: "Lower Level", row: "3", seats: "15-16", quantity: 2, delivery: "Mobile Entry", price: 95, boughtOn: "Sep 20, 2025", status: "past" },
  { id: 7, eventId: 18, orderId: "SH-20251004-2209", section: "Stage Front", row: "B", seats: "4", quantity: 1, delivery: "E-Ticket", price: 35, boughtOn: "Jul 30, 2025", status: "past" },
  { id: 8, eventId: 26, orderId: "SH-20251018-3351", section: "Turn 7 Grandstand", row: "T7", seats: "88-90", quantity: 3, delivery: "Mobile Entry", price: 425, boughtOn: "Aug 1, 2025", status: "past" },
  { id: 9, eventId: 9, orderId: "SH-20260905-6640", section: "Field Level", row: "F2", seats: "34", quantity: 1, delivery: "Mobile Entry", price: 180, boughtOn: "Apr 22, 2026", status: "selling", sellPrice: 210, progress: 80 },
  { id: 10, eventId: 14, orderId: "SH-20260725-9981", section: "General Admission", row: "GA", seats: "3-day pass", quantity: 2, delivery: "E-Ticket", price: 399, boughtOn: "Mar 30, 2026", status: "selling", sellPrice: 450, progress: 55 }
];

function getUserTickets(status) {
  return MY_TICKETS.filter(t => t.status === status);
}

function getTicketEvent(ticket) {
  return resolveEvent(ticket.eventId);
}

function getTicketById(id) {
  return MY_TICKETS.find(t => t.id === parseInt(id));
}

const MATT_RIFE_EVENTS = [
  { id: 70101, name: "Matt Rife", date: "2026-12-18", time: "8:00 PM", venue: "Dickies Arena", city: "Fort Worth", state: "TX", distance: 31, fromPrice: 150, soldOut: false },
  { id: 70102, name: "Matt Rife", date: "2026-12-19", time: "8:00 PM", venue: "Dickies Arena", city: "Fort Worth", state: "TX", distance: 31, fromPrice: 134, soldOut: false },
  { id: 70103, name: "Matt Rife", date: "2026-09-25", time: "8:00 PM", venue: "Choctaw Grand Theater", city: "Durant", state: "OK", distance: 84, fromPrice: 86, soldOut: false },
  { id: 70104, name: "Matt Rife", date: "2026-09-26", time: "8:00 PM", venue: "Choctaw Grand Theater", city: "Durant", state: "OK", distance: 84, fromPrice: 92, soldOut: false },
  { id: 70105, name: "Matt Rife", date: "2026-09-27", time: "7:30 PM", venue: "Walmart Arkansas Music Pavilion", city: "Rogers", state: "AR", distance: 0, fromPrice: 74, soldOut: false },
  { id: 70106, name: "Matt Rife", date: "2026-10-09", time: "8:00 PM", venue: "Arena at Ford Idaho Center", city: "Nampa", state: "ID", distance: 0, fromPrice: 69, soldOut: false },
  { id: 70107, name: "Matt Rife", date: "2026-10-10", time: "8:00 PM", venue: "Moda Center", city: "Portland", state: "OR", distance: 0, fromPrice: 88, soldOut: false },
  { id: 70108, name: "Matt Rife", date: "2026-10-11", time: "7:00 PM", venue: "Golden 1 Center", city: "Sacramento", state: "CA", distance: 0, fromPrice: 96, soldOut: false },
  { id: 70109, name: "Matt Rife", date: "2026-10-16", time: "8:00 PM", venue: "Chase Center", city: "San Francisco", state: "CA", distance: 0, fromPrice: 112, soldOut: false },
  { id: 70110, name: "Matt Rife", date: "2026-10-17", time: "8:00 PM", venue: "Chase Center", city: "San Francisco", state: "CA", distance: 0, fromPrice: 105, soldOut: false },
  { id: 70111, name: "Matt Rife", date: "2026-10-23", time: "7:30 PM", venue: "T-Mobile Arena", city: "Las Vegas", state: "NV", distance: 0, fromPrice: 78, soldOut: false },
  { id: 70112, name: "Matt Rife", date: "2026-10-24", time: "7:30 PM", venue: "T-Mobile Arena", city: "Las Vegas", state: "NV", distance: 0, fromPrice: 82, soldOut: true },
  { id: 70113, name: "Matt Rife", date: "2026-11-06", time: "8:00 PM", venue: "United Center", city: "Chicago", state: "IL", distance: 0, fromPrice: 95, soldOut: false },
  { id: 70114, name: "Matt Rife", date: "2026-11-07", time: "7:00 PM", venue: "United Center", city: "Chicago", state: "IL", distance: 0, fromPrice: 90, soldOut: false },
  { id: 70115, name: "Matt Rife", date: "2026-11-13", time: "8:00 PM", venue: "Little Caesars Arena", city: "Detroit", state: "MI", distance: 0, fromPrice: 71, soldOut: false },
  { id: 70116, name: "Matt Rife", date: "2026-11-20", time: "7:30 PM", venue: "Madison Square Garden", city: "New York", state: "NY", distance: 0, fromPrice: 148, soldOut: false },
  { id: 70117, name: "Matt Rife", date: "2026-11-21", time: "7:30 PM", venue: "Madison Square Garden", city: "New York", state: "NY", distance: 0, fromPrice: 155, soldOut: false },
  { id: 70118, name: "Matt Rife", date: "2026-12-04", time: "8:00 PM", venue: "Bell Centre", city: "Montreal", state: "QC", distance: 0, fromPrice: 84, soldOut: false },
  { id: 70119, name: "Matt Rife", date: "2026-12-12", time: "8:00 PM", venue: "Prudential Center", city: "Newark", state: "NJ", distance: 0, fromPrice: 102, soldOut: false },
  { id: 70120, name: "Matt Rife", date: "2027-01-15", time: "8:00 PM", venue: "Kaseya Center", city: "Miami", state: "FL", distance: 0, fromPrice: 79, soldOut: false },
  { id: 70121, name: "Matt Rife", date: "2027-01-16", time: "8:00 PM", venue: "Kaseya Center", city: "Miami", state: "FL", distance: 0, fromPrice: 83, soldOut: false },
  { id: 70122, name: "Matt Rife", date: "2027-02-06", time: "8:00 PM", venue: "Spectrum Center", city: "Charlotte", state: "NC", distance: 0, fromPrice: 67, soldOut: false }
];

function getMattRifeEvent(id) {
  return MATT_RIFE_EVENTS.find(e => e.id === parseInt(id));
}

function resolveEvent(id) {
  const base = getEventById(id);
  const tour = getMattRifeEvent(id);

  if (base) return base;
  if (!tour) return null;

  const d = new Date(tour.date + 'T00:00:00');
  return {
    id: tour.id,
    name: tour.name,
    date: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    venue: tour.venue,
    city: tour.city + ', ' + tour.state,
    image: 'assets/images/mattrife-card.jpg',
    category: 'comedy',
    subcategory: 'Comedy',
    price: tour.fromPrice,
    soldOut: tour.soldOut
  };
}

const ARTIST_NETWORKS = [
  {
    name: 'Matt Rife',
    keywords: ['matt rife', 'matt rif', 'mattrife'],
    href: 'matt-rife.html',
    image: 'assets/images/mattrife-card.jpg',
    description: 'Stand-up comedy tour dates',
    eventCount: MATT_RIFE_EVENTS.length
  }
];

function findArtistNetwork(query) {
  const q = (query || '').toLowerCase().trim();
  return ARTIST_NETWORKS.find(a => a.keywords.some(k => q.includes(k))) || null;
}

const TOP_CITIES = [
  "New York", "Los Angeles", "Chicago", "Houston", "Phoenix",
  "Philadelphia", "San Antonio", "San Diego", "Dallas", "Austin",
  "Las Vegas", "Miami", "Atlanta", "Boston", "Denver", "Seattle",
  "San Francisco", "Nashville", "New Orleans", "Orlando"
];

const COUNTRIES = [
  "United States", "Canada", "United Kingdom", "Germany", "France",
  "Italy", "Spain", "Netherlands", "Belgium", "Switzerland",
  "Austria", "Australia", "Japan", "South Korea", "Brazil",
  "Mexico", "Ireland", "Sweden", "Norway", "Denmark",
  "Finland", "Poland", "Portugal", "Czech Republic", "Hungary",
  "Romania", "Greece", "Turkey", "Israel", "India",
  "Singapore", "Hong Kong", "New Zealand", "South Africa", "Argentina",
  "Colombia", "Chile", "Peru", "Philippines", "Taiwan"
];

function getEventsByCategory(category) {
  return EVENTS.filter(e => e.category === category);
}

function getTrendingEvents() {
  return EVENTS.slice(0, 12);
}

function getPopularEvents() {
  return [EVENTS[7], EVENTS[6], EVENTS[12], EVENTS[13], EVENTS[22], EVENTS[14], EVENTS[24], EVENTS[8]];
}

function getLastMinuteDeals() {
  return EVENTS.filter(e => [5, 20, 21, 22, 10, 11, 18, 19].includes(e.id));
}

function searchEvents(query) {
  const q = (query || '').toLowerCase().trim();
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return EVENTS.slice();

  const fieldScore = (text, weight) => {
    if (!text) return 0;
    const t = text.toLowerCase();
    let score = 0;
    if (t.includes(q)) score += weight * 3;
    const hitRatio = terms.filter(term => t.includes(term)).length / terms.length;
    score += weight * hitRatio;
    return score;
  };

  const scoreEvent = (e) => {
    let score = 0;
    score += fieldScore(e.name, 10);
    score += fieldScore(e.performer, 8);
    score += fieldScore(e.city, 4);
    score += fieldScore(e.venue, 3);
    score += fieldScore(e.subcategory, 3);
    score += fieldScore(e.category, 2);
    if (e.name && e.name.toLowerCase() === q) score += 60;
    if (e.performer && e.performer.toLowerCase() === q) score += 40;
    return score;
  };

  const candidates = [
    ...EVENTS.map(e => ({ e, s: scoreEvent(e) })),
    ...MATT_RIFE_EVENTS.map(t => {
      const e = resolveEvent(t.id);
      return { e, s: scoreEvent(e) };
    })
  ];

  return candidates
    .filter(c => c.s > 0)
    .sort((a, b) => b.s - a.s)
    .map(c => c.e);
}

function getEventById(id) {
  return EVENTS.find(e => e.id === parseInt(id));
}

function generateTicketListings(event) {
  const sections = [
    { name: "Floor / Pit", rows: ["A", "B", "C"], priceMultiplier: 2.5 },
    { name: "Lower Level", rows: ["1", "2", "3", "4", "5"], priceMultiplier: 1.8 },
    { name: "Club Level", rows: ["CL1", "CL2", "CL3"], priceMultiplier: 2.0 },
    { name: "Upper Level", rows: ["U1", "U2", "U3", "U4"], priceMultiplier: 1.0 },
    { name: "Balcony", rows: ["B1", "B2"], priceMultiplier: 0.7 }
  ];

  const listings = [];
  sections.forEach(section => {
    section.rows.forEach(row => {
      const numTickets = Math.floor(Math.random() * 4) + 1;
      for (let i = 0; i < numTickets; i++) {
        const seats = Math.floor(Math.random() * 40) + 1;
        const price = Math.round(event.price * section.priceMultiplier * (0.8 + Math.random() * 0.4));
        listings.push({
          section: section.name,
          row: row,
          seats: seats,
          quantity: Math.floor(Math.random() * 4) + 1,
          price: price,
          type: Math.random() > 0.7 ? "E-Ticket" : "Mobile Entry"
        });
      }
    });
  });
  return listings.sort((a, b) => a.price - b.price);
}
