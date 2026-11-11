// The demo trip used in the reel and in the README: 6 friends, 23 expenses.
// Names and UPI IDs are made up. The "@demo" handle is not a real UPI app, so a
// tap on "Pay via UPI" can't send money to a stranger.
export const DEMO = {
  name: 'Digha trip',
  members: [
    { key: 'R', name: 'Rohan', upi: 'rohan.digha@demo' },
    { key: 'S', name: 'Sneha', upi: 'sneha.digha@demo' },
    { key: 'A', name: 'Ayan', upi: 'ayan.digha@demo' },
    { key: 'P', name: 'Priya', upi: 'priya.digha@demo' },
    { key: 'K', name: 'Karan', upi: 'karan.digha@demo' },
    { key: 'M', name: 'Meera', upi: 'meera.digha@demo' },
  ],
  // [title, rupees, paid by, split between ('*' = everyone)]
  // Listed oldest first; the app shows newest first.
  expenses: [
    ['Breakfast at Howrah', 360, 'K', '*'],
    ['Snacks for the train', 240, 'M', '*'],
    ['Toto to the hotel', 180, 'P', '*'],
    ['Lunch thali', 750, 'R', '*'],
    ['Beach chairs', 240, 'K', '*'],
    ['Banana boat ride', 800, 'A', 'RSAK'],
    ['Chai and biscuits', 120, 'S', '*'],
    ['Pizza', 500, 'K', 'RSAKM'],
    ['Ice cream', 240, 'S', 'SAPM'],
    ['Puchka', 180, 'M', '*'],
    ['Toto to Old Digha', 120, 'R', '*'],
    ['Amarabati Park entry', 120, 'S', '*'],
    ['Science Centre tickets', 510, 'A', '*'],
    ['Water bottles', 120, 'M', '*'],
    ['Kochuri breakfast', 300, 'P', '*'],
    ['Souvenir shells', 200, 'P', 'PM'],
    ['Toto to Mandarmani', 420, 'R', '*'],
    ['Prawn thali lunch', 840, 'K', '*'],
    ['Mocktails at the shack', 360, 'S', '*'],
    ['Sunscreen and meds', 420, 'M', '*'],
    ['Train', 2880, 'A', '*'],
    ['Fish fry', 1350, 'S', 'RSAKM'],
    ['Hotel', 7200, 'R', '*'],
  ],
};
