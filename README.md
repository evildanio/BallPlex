random browser vibe coded game i made because i'm a larp


SERVER REQUIREMENTS:


Any small Debian container will do. These are my estimates from how the server works, and I haven’t load-tested it.

CPU: 1 vCPU is enough. The physics for a lobby is trivial, and the main cost is turning each lobby’s 60 snapshots per second into JSON. One core should handle a few dozen active lobbies.

RAM: 256 MB is the minimum, and 512 MB is comfortable. Node idles around 50 MB and each lobby adds very little.

Disk: 2 GB is plenty. Node and the single dependency ws take a few hundred MB, and the game stores nothing.

Software: Debian 12 or 13, with Node.js 14 or newer. The nodejs package from apt on Debian 12 is v18, which works fine. An unprivileged container with no nesting or special features is fine.

Network: the game uses one TCP port (3000 by default) for both the page and the WebSocket. No UDP is needed.


just run npm install && node server.js in the game's directory to host and join by entering your server's ip in a browser on the same network or something.


also don't forget to change the admin password it's somewhere in the server.js file.

to open the admin login in game press the game's name 5 times.
