//imports up here
const Discord = require("discord.js");
require("dotenv").config();
const {
	prefix
} = require('./config.json');

const ytdl = require('ytdl-core');
const {google} = require('googleapis');
const { joinVoiceChannel, createAudioPlayer, AudioPlayerStatus, createAudioResource, getVoiceConnection, voice } = require('@discordjs/voice');
const { lookup } = require("dns");

//sort out these intents later, this looks like a complete dumpster fire
const client = new Discord.Client({ intents: ["GUILDS", "GUILD_MEMBERS", "GUILD_BANS", "GUILD_EMOJIS_AND_STICKERS", "GUILD_INTEGRATIONS", "GUILD_WEBHOOKS", "GUILD_INVITES", "GUILD_VOICE_STATES", "GUILD_PRESENCES", "GUILD_MESSAGE_REACTIONS", "GUILD_MESSAGE_TYPING", "DIRECT_MESSAGE_REACTIONS", "DIRECT_MESSAGE_TYPING", "GUILD_MESSAGES", "DIRECT_MESSAGES"], partials: ["CHANNEL"] });

const queue = new Map();
var connectedChannel; 
const player = createAudioPlayer();
var isLooped = false, isPaused = false; //will use this for managing loops between the play and loop functions

//status logged on run
client.on("ready", () => { 
  console.log("BOT ONLINE");
  client.user.setActivity("savant mode")
});

//listener for when someone disconnects the bot.
client.on('voiceStateUpdate', (oldState, newState) => { 
  if(oldState.channelId === null || typeof oldState.channelID == 'undefined') return;
  if (newState.id !== client.user.id) return;
  return queue.delete(oldState.guild.id);
})

//main command function
client.on("message", async message => { 
  if(message.author.bot) return;
  if (!message.content.startsWith(prefix)) return;

  const serverQueue = queue.get(message.guild.id);
  const voiceChannel = message.member.voice.channel;

  if(message.content.toLowerCase().startsWith(`${prefix}help`)){
    return help(message);
  }

  if(!voiceChannel) return message.channel.send("⚠️ You're not even in a voice channel, nerd <:4Weird:661277640811872266>");

  if(message.content.toLowerCase().startsWith(`${prefix}play`)){
    execute(message, serverQueue, voiceChannel);
  }
  else if(message.content.toLowerCase().startsWith(`${prefix}skip`)){
    skip(message, serverQueue);
  }
  else if(message.content.toLowerCase().startsWith(`${prefix}stop`)){
    stop(message, serverQueue, voiceChannel);
  }
  else if(message.content.toLowerCase().startsWith(`${prefix}pause`)){
    pause(message, serverQueue);
  }
  else if(message.content.toLowerCase().startsWith(`${prefix}queue`)){
    track(message, serverQueue);
  }
  else if(message.content.toLowerCase().startsWith(`${prefix}loop`)){
    loop(message, serverQueue, voiceChannel);
  }
  else if(message.content.toLowerCase().startsWith(`${prefix}pause`)){
    pause(message, serverQueue, voiceChannel);
  }
  else return;
});

//Whenever instructed to play a song we check a few edgecases and either first perform an add or a search.
async function execute(message, serverQueue, voiceChannel){
  const request = message.content.substring(6);
  console.log(`request entered for: ${request}`);
  const perms = voiceChannel.permissionsFor(message.client.user);

  if(!perms.has("CONNECT") || !perms.has("SPEAK"))
    return message.channel.send(`⚠️ I need permissions to play in ${voiceChannel.name}`);
  
  if(!request)
    return message.channel.send('<a:modCheck:784709635113222164> You forgot to request a song. You can request by either typing the video name or linking a youtube video after \'**!play**\'')

  //joining the channel.
  const channel = message.member.voice.channel
  try{
      const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
    });

    if(!connectedChannel) message.channel.send(`👍 **Joined** \`${voiceChannel.name}\` and bounded to ${message.channel} <a:docDJ:929366945885716510>`);
    connectedChannel = voiceChannel;
    console.log(`CONNECTED TO ${voiceChannel}`);
    if(request.startsWith("https://www.youtube.com/watch?v=")){
      try{
        addSong(message, serverQueue, await ytdl.getInfo(request), connection);
      } catch(err){
        if(err.message.search("Status code: 410") != -1)
          return message.reply("```css\n [The link you provided is age restricted, please try again with an unrestricted video OR search by the title]```");
      }
    }
    else 
      search(message, serverQueue, request, connection);
  } catch(err){
    console.log(err);
    queue.delete(message.guild.id);
    return message.channel.send(err);
  }
}

//search function using YouTube API v3 imported through googleapis
async function search(message, serverQueue, request, connection){
  message.channel.send(`🎵**Searching**🔎 \`${request}\` <a:docJAM:929366958988738610>`);
  google.youtube('v3').search.list({
    key: process.env.YOUTUBE_API_KEY,
    part: 'snippet',
    type: 'video',
    q: request,
  }).then(async (response)  => { 
    try{
      const songInfo = await ytdl.getInfo(`https://www.youtube.com/watch?v=${response.data.items[0].id.videoId}`);
      addSong(message, serverQueue, songInfo, connection);
    }catch(err){ //age restriction bypass using a nested try-catch, ugly but hey it works nicely, O(n)
      var i = 1;
      var songInfo;
      try{
        console.log(`attempt of bypass #${i}`);
        songInfo = await ytdl.getInfo(`https://www.youtube.com/watch?v=${response.data.items[i].id.videoId}`);
      } catch(err){
        i++;
      }
      finally{
        console.log("ADDING NON-AGE-RESTRICTED SONG TO QUEUE.")
        addSong(message, serverQueue, songInfo, connection);
      }
    }
  }).catch((err) => console.log(err));
}

//enqueues the song request to the queue, and invokes play()
async function addSong(message, serverQueue, songInfo, connection){
  const song = {
    title: songInfo.videoDetails.title,
    url: songInfo.videoDetails.video_url
  };

  if(!serverQueue){
    const q = { //struct of a queue
      textChannel: message.channel,
      voiceChannel: message.member.voice.channel,
      connection: connection,
      songs: [],
      volume: 2,
      playing: true
    };

    queue.set(message.guild.id, q);
    q.songs.push(song);
    play(message.guild, q.songs[0], connection, serverQueue);
  } else {
      serverQueue.songs.push(song);
      return message.channel.send(`\`${song.title}\` has been added to the queue! <a:docDJ:929366945885716510>`);
  }
}

//uses the @discord.js/voice stand-alone library and libsodium wrappers
function play(guild, song, connection, serverQueue){
  serverQueue = queue.get(guild.id);
  const subscription = connection.subscribe(player);
  console.log("ENTERED PLAY FUNCTION!");

  //checks if there's a song in the queue and if the bot is playing something
  if(!song){
    isLooped = false;
  setTimeout(() => subscription.unsubscribe(), 200_000);
    connection.disconnect();
    connectedChannel = null;
    queue.delete(guild.id);
    return console.log(`Queue end. Bot disconnected.`);
  }

  let resource = createAudioResource((ytdl(song.url)));

  player.play(resource);
  serverQueue.textChannel.send(`<a:docPls:929365030389035018> **Playing** 🎶 \`${song.title}\` NOW! <a:docPls:929365030389035018>`);
  console.log(`logged: playing [${song.title}, ${song.url}]}`)
  player.on(AudioPlayerStatus.Playing, () =>{
    if(isPaused)
      player.pause();
  })

  player.on(AudioPlayerStatus.Idle, () => {
    if(isLooped){
      let temp = createAudioResource((ytdl(song.url)));
      player.play(temp);
    }
    else {
      serverQueue.songs.shift();
      play(guild, serverQueue.songs[0], connection, serverQueue);
    }
  });

  player.on(AudioPlayerStatus.Paused, () => {
    if(!isPaused)
      player.unpause();
  })

  player.on("error", error => console.error(error));
}

//dequeues the current track and plays the next
function skip(message, serverQueue){
  if(!serverQueue)
    return message.channel.send("the queue is currently empty.");
  serverQueue.songs.shift();
  play(message.guild, serverQueue.songs[0], serverQueue.connection);
  return message.channel.send("⏩ **Skipped** 👍")
}

//clears the queue and disconnects the bot. ONLY permissible if you're in the same channel as the bot. no sneaky exploits ;)
function stop(message, serverQueue, userChannel){
  if(!serverQueue)
    return message.channel.send("the queue is currently empty.");
  if(!getVoiceConnection(message.guild.id) || userChannel !== connectedChannel)
    return message.channel.send("The bot is currently not connected to your voice channel.");

  getVoiceConnection(message.guild.id).destroy();
  player.stop();
  connectedChannel = null;
  queue.delete(message.guild.id);
  return message.channel.send("🛑 **Stopping the queue** 🛑 Goodbye. <:OkayChamp:613374167319969814>")
}

//prints out the queue. Will update this to be an embedded message, make it look all fancy
function track(message, serverQueue){
    if(!serverQueue)
      return message.channel.send("the queue is currently empty.");
    var output = '';
    var i = 1;
    serverQueue.songs.forEach(song => {
      output += `\`${i}. ${song.title}\`\n` 
      i++;
    })
    const queueEmbed = new Discord.MessageEmbed()
    .setColor('#ff3e94')
    .setTitle(`Queue for ${message.guild.name}`)
    .setDescription(`**__Now Playing:__** \`${serverQueue.songs[0].title}\``)
    .addField(' \n', ` \n`)
    .addField('\n\n⬇️__Up Next__⬇️', `${output}`);

    message.channel.send({embeds: [queueEmbed]});
}

function loop(message, serverQueue, userChannel){
  if(!serverQueue)
    return message.channel.send("the queue is currently empty.");
  if(userChannel !== connectedChannel)
    return message.channel.send("The bot is currently not connected to your voice channel.");

  isLooped = isLooped == true ? false : true;
  console.log(`loop flag is ${isLooped}`);

  if(isLooped) message.channel.send('🔁**Loop Enabled** <a:ppCircle:929561763786145882>')
  else message.channel.send('🔁**Loop Disabled** <a:ppCircle:929561763786145882>')
}

function pause(message, serverQueue, userChannel){
  if(!serverQueue)
    return message.channel.send("the queue is currently empty.");
  userChannel = message.member.voice.channel;
  if(userChannel !== connectedChannel)
    return message.channel.send("The bot is currently not connected to your voice channel.");

  isPaused = isPaused == true ? false : true;
  if(isPaused){
    player.pause(true);
    message.channel.send('⏸️**Paused** <a:docDJ:929366945885716510>')
  } else {
    player.unpause(true);
    message.channel.send('⏸️**Unpaused** <a:docDJ:929366945885716510>')
  }
}

function help(message){
  const helpEmbed = new Discord.MessageEmbed()
    .setColor('#ff3e94')
    .setTitle('🔧 Need some help?')
    .addField('!play [link or query]', 'to add a song to the queue.')
    .addField('!skip', 'will skip the current song being played from the queue.')
    .addField('!loop', 'use this to toggle a loop of the current song being played.')
    .addField('!pause', 'use this to pause and unpause the song and queue whenever you want.')
    .addField('!stop', 'stops the song that\'s playing, empties the queue, and leaves the voice channel.')
    .addField('!queue', 'lists the current songs that are in the queue.')

  message.channel.send({embeds: [helpEmbed]})
}



//little easter egg
client.on("message", msg => {
  if(msg.content === "go doc go") 
    msg.reply("<a:docPls:929365030389035018>");
})

client.login(process.env.TOKEN)