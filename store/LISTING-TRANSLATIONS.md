# Translated store listing copy

Paste-ready listing text for every language the extension ships in, for both
stores. The English original and all the review answers stay in
[LISTING.md](LISTING.md); this file is only the translations.

## One file per field

If you would rather not select text out of this document, `npm run listings`
writes every field to its own plain file:

```
store/listings/<locale>/name.txt
store/listings/<locale>/summary.txt
store/listings/<locale>/description.txt
```

Open one, select all, paste. Those files are generated from this one, so edit
here and regenerate rather than editing them.

## How to use this

**Chrome Web Store.** Item, then the language dropdown at the top of the
listing editor. Add a language, paste that language's Name, Summary and
Description into the three fields, save, repeat. Chrome shows a listing in the
user's browser language when one exists and falls back to the default language
when it does not, so there is no penalty for a language being absent.

**Firefox add-ons.** Manage Listing, then "Add a locale" beside the Name field.
AMO wants Name, Summary and Description per locale in the same way. AMO also
localises the add-on name from `_locales`, so the name field there will already
be populated in each language the package ships.

Field limits, which the build checks for the manifest strings and which you
have to respect by hand here:

| Field | Chrome Web Store | AMO |
| --- | --- | --- |
| Name | 75 | 50 |
| Summary | 132 | 250 |
| Description | 16,000 | no practical limit |

Every Name below is under 50 so it fits both. Every Summary is under 132 so it
fits both. Screenshots for German, Japanese, Russian and Turkish are in
`store/screenshots/<locale>/`; regenerate any locale with
`npm run shots -- <locale>`.

Languages: English, Spanish, Brazilian Portuguese, French, German, Italian,
Polish, Turkish, Russian, Japanese, Korean.

---

## English (en)

**Name**

```
Clearline - Message Manager for Discord
```

**Summary**

```
Search, export and bulk delete your own Discord messages. Your token never leaves the browser.
```

**Description**: use the full text in [LISTING.md](LISTING.md).

---

## Spanish (es)

**Name**

```
Clearline - Gestor de mensajes para Discord
```

**Summary**

```
Busca, exporta y borra en masa tus propios mensajes de Discord. Tu token nunca sale del navegador.
```

**Description**

```
Clearline encuentra los mensajes que escribiste en Discord, te los enseña y te deja
guardarlos o eliminarlos.

Discord no ofrece ninguna forma de borrar más de un mensaje a la vez. Clearline los va
recorriendo por ti, con cuidado, y te muestra exactamente lo que va a tocar antes de
tocar nada.

CÓMO FUNCIONA

Abre Discord en una pestaña, inicia sesión y pulsa el icono de Clearline. Son cinco
pasos, una pantalla cada vez.

1. Conectar. Clearline lee tu sesión desde la pestaña de Discord que ya tienes abierta.
2. Dónde. Elige un servidor, algunos de sus canales o un mensaje directo.
3. Filtrar. Filtra por texto o por un patrón, por un intervalo de fechas, por si el
   mensaje tiene archivo adjunto, enlace o vista previa, y decide si dejar en paz los
   mensajes fijados.
4. Revisar. Mira el número y los mensajes en sí. Desmarca lo que quieras conservar.
   Guarda una copia en HTML, JSON o CSV.
5. Actuar. Bórralos, sobrescribe el texto, o sobrescribe y luego borra. Mira cómo
   avanza, pon en pausa o para.

PRUDENTE POR DEFECTO

No se puede llegar al botón de borrar sin haber visto antes un recuento y los mensajes
que hay detrás. Antes de empezar verás una frase clara que dice cuántos mensajes, en
qué sitio, con qué filtro, cuánto tardará aproximadamente y que no se puede deshacer.
Las ejecuciones de más de cien mensajes te piden que escribas el número. La copia se
prepara y se entrega a tu navegador antes del primer borrado, así que si va a fallar,
falla mientras los mensajes todavía existen.

El recuento solo incluye los mensajes que Discord te dejará borrar de verdad. Los
avisos de entrada y otros mensajes del sistema se te atribuyen y aparecen en los
resultados, pero nadie puede borrarlos, así que Clearline los nombra aparte y los deja
intactos en lugar de prometer más de lo que puede cumplir.

Al terminar recibes un informe que separa lo que falló de lo que se dejó intacto, y te
ofrece reintentar los fallos.

A UN RITMO QUE TU CUENTA AGUANTE

Esta es la parte que más importa y la más fácil de hacer mal.

Todas las peticiones pasan por una única cola, de una en una, con un retardo entre
escrituras que no se puede bajar. Las respuestas de límite de velocidad se leen y se
respetan. Cuatro seguidas paran la ejecución, porque seguir generándolas es lo que
acaba bloqueando una IP durante una hora.

Solo funciona una pestaña de Clearline a la vez, porque una segunda pestaña sería una
segunda cola y Discord vería el doble de ritmo. La segunda te lo dice y te ofrece tomar
el control.

TU TOKEN

Discord no tiene ninguna forma de autorizar a una aplicación a leer o borrar tu propio
historial de mensajes, así que las herramientas como esta trabajan con la sesión que tu
navegador ya tiene. Decirlo claramente importa más que disimularlo.

Clearline lee tu sesión desde una pestaña abierta de Discord, solo cuando pulsas
Conectar. Se queda en la memoria de esa pestaña, nunca se guarda en el almacenamiento y
desaparece al cerrarla. El único sitio al que puede llegar la extensión es discord.com.
No hay cuenta, ni servidor, ni analíticas, ni telemetría.

La extensión pide un solo permiso, almacenamiento, y lo usa para recordar un número de
pestaña.

ANTES DE USARLA

Automatizar una cuenta de usuario va contra las condiciones del servicio de Discord, y
hay gente a la que le han sancionado la cuenta por ello. Clearline se autolimita mucho
más que las alternativas, lo que reduce las probabilidades sin eliminarlas. Si perder la
cuenta te supondría un problema serio, exporta primero y decide si merece la pena.

Hay un solo enlace en la extensión, a una página de Buy Me a Coffee, al final de la
ventana. Es opcional, es un enlace y nada más, y no se pide nada a ese sitio a menos que
lo pulses.

Clearline es gratuito y de código abierto bajo la licencia MIT. No tiene afiliación,
respaldo ni conexión con Discord Inc.
```

---

## Brazilian Portuguese (pt-BR)

**Name**

```
Clearline - Gerenciador de mensagens do Discord
```

**Summary**

```
Pesquise, exporte e apague em massa suas mensagens do Discord. Seu token nunca sai do navegador.
```

**Description**

```
O Clearline encontra as mensagens que você escreveu no Discord, mostra elas para você e
deixa você salvar ou remover.

O Discord não oferece nenhum jeito de apagar mais de uma mensagem por vez. O Clearline
passa por elas para você, com cuidado, e mostra exatamente o que vai mexer antes de
mexer em qualquer coisa.

COMO FUNCIONA

Abra o Discord em uma aba, entre na sua conta e clique no ícone do Clearline. São cinco
passos, uma tela por vez.

1. Conectar. O Clearline lê sua sessão da aba do Discord que você já tem aberta.
2. Onde. Escolha um servidor, alguns canais dele ou uma conversa privada.
3. Filtrar. Filtre por texto ou por um padrão, por intervalo de datas, por ter anexo,
   link ou prévia de link, e escolha se quer deixar as mensagens fixadas em paz.
4. Revisar. Veja a contagem e as mensagens em si. Desmarque o que quiser manter. Salve
   uma cópia em HTML, JSON ou CSV.
5. Agir. Apague, sobrescreva o texto, ou sobrescreva e depois apague. Acompanhe,
   pause ou interrompa.

CUIDADOSO POR PADRÃO

Não dá para chegar ao botão de apagar sem antes ver uma contagem e as mensagens por
trás dela. Antes de começar você recebe uma frase direta dizendo quantas mensagens, em
que lugar, com que filtro, quanto tempo deve levar e que não dá para desfazer. Runs
acima de cem mensagens pedem que você digite o número de volta. A cópia é montada e
entregue ao seu navegador antes da primeira exclusão, então se ela for falhar, falha
enquanto as mensagens ainda existem.

A contagem só inclui mensagens que o Discord realmente deixa você apagar. Avisos de
entrada e outras mensagens de sistema são atribuídos a você e aparecem nos resultados,
mas ninguém consegue apagá-los, então o Clearline os nomeia à parte e deixa intactos em
vez de prometer mais do que consegue entregar.

No fim você recebe um relatório que separa o que falhou do que foi deixado de lado, e
oferece repetir as falhas.

NO RITMO CERTO PARA SUA CONTA SOBREVIVER

Esta é a parte que mais importa e a mais fácil de errar.

Toda requisição passa por uma fila única, uma de cada vez, com um intervalo entre
escritas que não dá para diminuir. As respostas de limite de taxa são lidas e
respeitadas. Quatro seguidas param a execução, porque continuar gerando essas respostas
é o que faz um IP ser bloqueado por uma hora.

Só uma aba do Clearline funciona por vez, já que uma segunda aba seria uma segunda fila
e o Discord veria o dobro do ritmo. A segunda avisa isso e oferece assumir o controle.

SEU TOKEN

O Discord não tem como autorizar um aplicativo a ler ou apagar seu próprio histórico de
mensagens, então ferramentas como esta trabalham com a sessão que seu navegador já tem.
Ser franco sobre isso importa mais do que disfarçar.

O Clearline lê sua sessão de uma aba aberta do Discord, só quando você clica em
Conectar. Ela fica na memória daquela aba, nunca é gravada em armazenamento e some
quando você fecha a aba. O único site que a extensão alcança é o discord.com. Não tem
conta, não tem servidor, não tem análise de uso nem telemetria.

A extensão pede uma única permissão, armazenamento, usada para lembrar um número de aba.

ANTES DE USAR

Automatizar uma conta de usuário vai contra os termos de serviço do Discord, e tem gente
que já sofreu punição por isso. O Clearline se controla muito mais que as alternativas,
o que reduz as chances sem eliminá-las. Se perder a conta seria um problema sério,
exporte primeiro e decida se a exclusão vale a pena.

Existe um único link na extensão, para uma página do Buy Me a Coffee, no rodapé da
janela. É opcional, é um link e nada mais, e nada é pedido àquele site a menos que você
clique.

O Clearline é gratuito e de código aberto sob a licença MIT. Não tem afiliação, apoio
nem ligação com a Discord Inc.
```

---

## French (fr)

**Name**

```
Clearline - Gestionnaire de messages Discord
```

**Summary**

```
Recherchez, exportez et supprimez en masse vos messages Discord. Votre jeton ne quitte jamais le navigateur.
```

**Description**

```
Clearline retrouve les messages que vous avez écrits sur Discord, vous les montre, et
vous laisse les enregistrer ou les supprimer.

Discord ne propose aucun moyen de supprimer plus d'un message à la fois. Clearline les
traite pour vous, avec précaution, et vous montre exactement ce qu'il s'apprête à
toucher avant de toucher quoi que ce soit.

COMMENT ÇA MARCHE

Ouvrez Discord dans un onglet, connectez-vous, puis cliquez sur l'icône Clearline. Cela
se fait en cinq étapes, un écran à la fois.

1. Connexion. Clearline lit votre session depuis l'onglet Discord que vous avez déjà
   ouvert.
2. Où. Choisissez un serveur, certains de ses salons, ou un message privé.
3. Filtrer. Filtrez par texte ou par motif, par plage de dates, selon qu'un message
   contient une pièce jointe, un lien ou un aperçu, et choisissez de laisser ou non les
   messages épinglés tranquilles.
4. Vérifier. Voyez le nombre et les messages eux-mêmes. Décochez ce que vous voulez
   garder. Enregistrez une copie en HTML, JSON ou CSV.
5. Agir. Supprimez-les, remplacez le texte, ou remplacez puis supprimez. Suivez
   l'exécution, mettez-la en pause ou arrêtez-la.

PRUDENT PAR DÉFAUT

Le bouton de suppression est inaccessible tant que vous n'avez pas vu un décompte et les
messages qui vont avec. Avant le démarrage, une phrase claire indique combien de
messages, à quel endroit, correspondant à quoi, combien de temps cela prendra environ,
et que c'est irréversible. Au-delà de cent messages, il faut retaper le nombre. La copie
est constituée et remise à votre navigateur avant la première suppression, donc si elle
doit échouer, elle échoue pendant que les messages existent encore.

Le décompte ne compte que les messages que Discord vous laissera réellement supprimer.
Les avis d'arrivée et autres messages système vous sont attribués et remontent dans les
résultats, mais personne ne peut les supprimer : Clearline les nomme à part et les
laisse intacts plutôt que de promettre plus qu'il ne peut tenir.

À la fin, un rapport sépare ce qui a échoué de ce qui a été laissé de côté, et propose
de réessayer les échecs.

À UN RYTHME QUE VOTRE COMPTE SUPPORTE

C'est la partie la plus importante, et la plus facile à rater.

Chaque requête passe par une file unique, une à la fois, avec un délai entre écritures
que vous ne pouvez pas réduire. Les réponses de limitation sont lues et respectées.
Quatre d'affilée arrêtent l'exécution, car continuer à en provoquer est précisément ce
qui fait bloquer une adresse IP pendant une heure.

Un seul onglet Clearline fonctionne à la fois, puisqu'un deuxième onglet serait une
deuxième file et Discord verrait un rythme doublé. Le second vous le dit et propose de
prendre la main.

VOTRE JETON

Discord n'offre aucun moyen d'autoriser une application à lire ou supprimer votre propre
historique, donc les outils de ce type travaillent à partir de la session que votre
navigateur détient déjà. Le dire franchement compte davantage que de l'esquiver.

Clearline lit votre session depuis un onglet Discord ouvert, uniquement quand vous
cliquez sur Connexion. Elle reste dans la mémoire de cet onglet, n'est jamais écrite
dans le stockage, et disparaît à la fermeture. Le seul site que l'extension peut
atteindre est discord.com. Pas de compte, pas de serveur, pas de statistiques, pas de
télémétrie.

L'extension demande une seule permission, le stockage, pour retenir un numéro d'onglet.

AVANT DE L'UTILISER

Automatiser un compte utilisateur va à l'encontre des conditions d'utilisation de
Discord, et des comptes ont déjà été sanctionnés pour cela. Clearline se limite bien
davantage que les alternatives, ce qui réduit le risque sans le supprimer. Si perdre le
compte serait un vrai problème, exportez d'abord et demandez-vous si la suppression en
vaut la peine.

Il y a un seul lien dans l'extension, vers une page Buy Me a Coffee, en bas de la
fenêtre. Il est facultatif, c'est un lien et rien de plus, et rien n'est demandé à ce
site tant que vous ne cliquez pas.

Clearline est gratuit et open source sous licence MIT. Sans affiliation, approbation ni
lien avec Discord Inc.
```

---

## German (de)

**Name**

```
Clearline - Nachrichtenmanager für Discord
```

**Summary**

```
Eigene Discord-Nachrichten suchen, exportieren und massenhaft löschen. Dein Token verlässt den Browser nie.
```

**Description**

```
Clearline findet die Nachrichten, die du auf Discord geschrieben hast, zeigt sie dir und
lässt dich sie sichern oder entfernen.

Discord bietet keine Möglichkeit, mehr als eine Nachricht auf einmal zu löschen.
Clearline arbeitet sie für dich ab, sorgfältig, und zeigt dir genau, was es anfassen
wird, bevor es irgendetwas anfasst.

SO FUNKTIONIERT ES

Öffne Discord in einem Tab, melde dich an und klicke auf das Clearline-Symbol. Es geht
in fünf Schritten, immer ein Bildschirm auf einmal.

1. Verbinden. Clearline liest deine Sitzung aus dem Discord-Tab, den du ohnehin offen
   hast.
2. Wo. Wähle einen Server, einzelne Kanäle davon oder eine Direktnachricht.
3. Filtern. Filtere nach Text oder Muster, nach Zeitraum, danach ob eine Nachricht
   einen Anhang, einen Link oder eine Linkvorschau hat, und entscheide, ob angepinnte
   Nachrichten in Ruhe bleiben.
4. Prüfen. Sieh dir die Anzahl und die Nachrichten selbst an. Hake ab, was du behalten
   willst. Sichere eine Kopie als HTML, JSON oder CSV.
5. Ausführen. Löschen, den Text überschreiben, oder überschreiben und dann löschen. Sieh
   zu, pausiere oder brich ab.

VON HAUS AUS VORSICHTIG

Der Löschknopf ist nicht erreichbar, ohne vorher eine Anzahl und die dazugehörigen
Nachrichten gesehen zu haben. Vor dem Start steht ein klarer Satz da: wie viele
Nachrichten, an welchem Ort, passend worauf, wie lange es ungefähr dauert, und dass es
sich nicht rückgängig machen lässt. Ab hundert Nachrichten musst du die Zahl abtippen.
Die Kopie wird vor der ersten Löschung erstellt und an deinen Browser übergeben, nicht
nebenher, damit sie scheitert, solange die Nachrichten noch da sind.

Die Anzahl umfasst nur Nachrichten, die Discord dich auch wirklich löschen lässt.
Beitrittshinweise und ähnliche Systemmeldungen werden dir zugeschrieben und tauchen in
den Ergebnissen auf, aber niemand kann sie löschen. Clearline benennt sie deshalb
gesondert und lässt sie in Ruhe, statt mehr zu versprechen, als es halten kann.

Danach bekommst du einen Bericht, der Fehlschläge von Übersprungenem trennt und anbietet,
die Fehlschläge zu wiederholen.

IN EINEM TEMPO, DAS DEIN KONTO ÜBERSTEHT

Das ist der wichtigste Teil und der, den man am leichtesten falsch macht.

Jede Anfrage läuft durch eine einzige Warteschlange, eine nach der anderen, mit einem
Abstand zwischen Schreibvorgängen, den du nicht verringern kannst. Antworten zur
Ratenbegrenzung werden gelesen und eingehalten. Vier hintereinander stoppen den
Durchlauf, denn weiter welche zu erzeugen ist genau das, was eine IP-Adresse für eine
Stunde sperren lässt.

Es arbeitet immer nur ein Clearline-Tab, weil ein zweiter Tab eine zweite Warteschlange
wäre und Discord das doppelte Tempo sähe. Der zweite sagt dir das und bietet an zu
übernehmen.

DEIN TOKEN

Discord hat keine Möglichkeit, einer App das Lesen oder Löschen deines eigenen
Nachrichtenverlaufs zu erlauben, also arbeiten Werkzeuge wie dieses mit der Sitzung, die
dein Browser ohnehin hält. Das offen zu sagen ist wichtiger, als darüber hinwegzugehen.

Clearline liest deine Sitzung aus einem offenen Discord-Tab, und nur dann, wenn du auf
Verbinden klickst. Sie bleibt im Speicher dieses Tabs, wird nie in den Speicher
geschrieben und ist weg, sobald du den Tab schließt. Die einzige Seite, die die
Erweiterung erreichen kann, ist discord.com. Kein Konto, kein Server, keine Analyse,
keine Telemetrie.

Die Erweiterung fordert eine einzige Berechtigung an, Speicher, und merkt sich damit eine
einzelne Tab-Nummer.

BEVOR DU ES BENUTZT

Ein Nutzerkonto zu automatisieren verstößt gegen Discords Nutzungsbedingungen, und es
gibt Leute, deren Konten dafür belangt wurden. Clearline bremst sich weit stärker als die
Alternativen, was die Wahrscheinlichkeit senkt, aber nicht beseitigt. Wenn der Verlust
des Kontos ein ernstes Problem wäre, exportiere erst und überlege dann, ob das Löschen es
wert ist.

Es gibt einen einzigen Link in der Erweiterung, zu einer Buy-Me-a-Coffee-Seite, unten im
Fenster. Er ist optional, er ist ein Link und nichts weiter, und von dieser Seite wird
nichts angefordert, solange du nicht klickst.

Clearline ist kostenlos und quelloffen unter der MIT-Lizenz. Nicht verbunden mit,
unterstützt von oder in Beziehung zu Discord Inc.
```

---

## Italian (it)

**Name**

```
Clearline - Gestore di messaggi per Discord
```

**Summary**

```
Cerca, esporta ed elimina in blocco i tuoi messaggi di Discord. Il tuo token non lascia mai il browser.
```

**Description**

```
Clearline trova i messaggi che hai scritto su Discord, te li mostra e ti lascia salvarli
o rimuoverli.

Discord non offre alcun modo di eliminare più di un messaggio alla volta. Clearline li
percorre al posto tuo, con attenzione, e ti mostra esattamente cosa sta per toccare
prima di toccare qualsiasi cosa.

COME FUNZIONA

Apri Discord in una scheda, accedi e clicca l'icona di Clearline. Sono cinque passi, una
schermata per volta.

1. Connetti. Clearline legge la tua sessione dalla scheda di Discord che hai già aperta.
2. Dove. Scegli un server, alcuni dei suoi canali o una conversazione privata.
3. Filtra. Filtra per testo o per pattern, per intervallo di date, per la presenza di un
   allegato, un link o un'anteprima, e decidi se lasciare stare i messaggi fissati.
4. Controlla. Guarda il conteggio e i messaggi stessi. Togli la spunta a ciò che vuoi
   tenere. Salva una copia in HTML, JSON o CSV.
5. Agisci. Eliminali, sovrascrivi il testo, oppure sovrascrivi e poi elimina. Guarda
   l'avanzamento, mettilo in pausa o fermalo.

PRUDENTE PER IMPOSTAZIONE PREDEFINITA

Al pulsante di eliminazione non si arriva senza aver prima visto un conteggio e i
messaggi che ci stanno dietro. Prima dell'avvio compare una frase chiara: quanti
messaggi, in quale posto, che corrispondono a cosa, quanto tempo ci vorrà all'incirca e
che non si può annullare. Sopra i cento messaggi ti viene chiesto di riscrivere il
numero. La copia viene preparata e consegnata al browser prima della prima eliminazione,
così se deve fallire fallisce mentre i messaggi esistono ancora.

Il conteggio include solo i messaggi che Discord ti lascerà davvero eliminare. Gli avvisi
di ingresso e altri messaggi di sistema ti vengono attribuiti e compaiono nei risultati,
ma nessuno può eliminarli: Clearline li nomina a parte e li lascia intatti invece di
promettere più di quanto possa mantenere.

Alla fine ricevi un resoconto che separa ciò che è fallito da ciò che è stato saltato, e
ti propone di riprovare i fallimenti.

A UN RITMO CHE IL TUO ACCOUNT REGGE

È la parte che conta di più ed è la più facile da sbagliare.

Ogni richiesta passa da un'unica coda, una alla volta, con un ritardo tra le scritture
che non puoi abbassare. Le risposte sui limiti di frequenza vengono lette e rispettate.
Quattro di fila fermano l'esecuzione, perché continuare a generarle è esattamente ciò che
fa bloccare un indirizzo IP per un'ora.

Funziona una sola scheda di Clearline per volta, perché una seconda scheda sarebbe una
seconda coda e Discord vedrebbe il doppio del ritmo. La seconda te lo dice e ti propone
di prendere il controllo.

IL TUO TOKEN

Discord non ha alcun modo di autorizzare un'app a leggere o eliminare la tua cronologia
dei messaggi, quindi gli strumenti come questo lavorano con la sessione che il browser ha
già. Dirlo chiaramente conta più che glissarci sopra.

Clearline legge la tua sessione da una scheda di Discord aperta, solo quando clicchi
Connetti. Resta nella memoria di quella scheda, non viene mai scritta in memoria
permanente e sparisce quando la chiudi. L'unico sito che l'estensione può raggiungere è
discord.com. Nessun account, nessun server, nessuna analisi, nessuna telemetria.

L'estensione chiede un solo permesso, l'archiviazione, e lo usa per ricordare un numero
di scheda.

PRIMA DI USARLO

Automatizzare un account utente va contro i termini di servizio di Discord, e c'è chi si
è visto sanzionare l'account per questo. Clearline si autolimita molto più delle
alternative, il che riduce le probabilità senza eliminarle. Se perdere l'account sarebbe
un problema serio, esporta prima e valuta se l'eliminazione ne vale la pena.

C'è un solo link nell'estensione, a una pagina Buy Me a Coffee, in fondo alla finestra. È
facoltativo, è un link e nulla più, e a quel sito non viene chiesto nulla a meno che tu
non ci clicchi.

Clearline è gratuito e open source con licenza MIT. Non è affiliato, approvato o
collegato a Discord Inc.
```

---

## Polish (pl)

**Name**

```
Clearline - Menedżer wiadomości do Discorda
```

**Summary**

```
Wyszukuj, eksportuj i masowo usuwaj własne wiadomości z Discorda. Token nie opuszcza przeglądarki.
```

**Description**

```
Clearline znajduje wiadomości, które napisałeś na Discordzie, pokazuje ci je i pozwala je
zapisać albo usunąć.

Discord nie daje żadnego sposobu na usunięcie więcej niż jednej wiadomości naraz.
Clearline przechodzi je za ciebie, ostrożnie, i pokazuje dokładnie, czego zamierza
dotknąć, zanim czegokolwiek dotknie.

JAK TO DZIAŁA

Otwórz Discorda w karcie, zaloguj się i kliknij ikonę Clearline. Idzie to w pięciu
krokach, po jednym ekranie naraz.

1. Połącz. Clearline czyta twoją sesję z karty Discorda, którą i tak masz otwartą.
2. Gdzie. Wybierz serwer, kilka jego kanałów albo rozmowę prywatną.
3. Zawęź. Filtruj po tekście lub wzorcu, po zakresie dat, po tym czy wiadomość ma
   załącznik, link albo podgląd linku, i zdecyduj, czy zostawić przypięte w spokoju.
4. Sprawdź. Zobacz liczbę i same wiadomości. Odznacz to, co chcesz zachować. Zapisz
   kopię w HTML, JSON albo CSV.
5. Działaj. Usuń je, nadpisz tekst, albo nadpisz i potem usuń. Patrz, jak idzie,
   wstrzymaj albo zatrzymaj.

OSTROŻNY DOMYŚLNIE

Do przycisku usuwania nie da się dojść bez wcześniejszego zobaczenia liczby i samych
wiadomości. Przed startem dostajesz jedno jasne zdanie: ile wiadomości, w jakim miejscu,
pasujących do czego, ile to mniej więcej potrwa i że nie da się tego cofnąć. Przy ponad
stu wiadomościach trzeba wpisać tę liczbę z powrotem. Kopia jest przygotowywana i
przekazywana przeglądarce przed pierwszym usunięciem, więc jeśli ma się nie udać, nie
uda się, póki wiadomości jeszcze istnieją.

Liczba obejmuje tylko wiadomości, które Discord rzeczywiście pozwoli ci usunąć.
Powiadomienia o dołączeniu i inne wiadomości systemowe są przypisane tobie i wracają w
wynikach, ale nikt nie może ich usunąć, więc Clearline wymienia je osobno i zostawia w
spokoju, zamiast obiecywać więcej, niż jest w stanie dowieźć.

Na koniec dostajesz raport, który oddziela to, co się nie udało, od tego, co pominięto, i
proponuje ponowienie nieudanych.

W TEMPIE, KTÓRE TWOJE KONTO PRZETRWA

To najważniejsza część i ta, którą najłatwiej zepsuć.

Każde żądanie idzie przez jedną kolejkę, po jednym naraz, z odstępem między zapisami,
którego nie da się zmniejszyć. Odpowiedzi o ograniczeniu tempa są odczytywane i
respektowane. Cztery pod rząd zatrzymują zadanie, bo dalsze ich generowanie jest właśnie
tym, co kończy się blokadą adresu IP na godzinę.

Naraz działa tylko jedna karta Clearline, bo druga byłaby drugą kolejką i Discord
zobaczyłby dwa razy większe tempo. Druga karta mówi ci o tym i proponuje przejęcie.

TWÓJ TOKEN

Discord nie ma sposobu, by upoważnić aplikację do czytania albo usuwania twojej własnej
historii wiadomości, więc narzędzia takie jak to pracują na sesji, którą przeglądarka i
tak trzyma. Powiedzenie tego wprost znaczy więcej niż omijanie tematu.

Clearline czyta twoją sesję z otwartej karty Discorda, i tylko wtedy, gdy klikniesz
Połącz. Zostaje w pamięci tej karty, nigdy nie trafia do pamięci trwałej i znika, gdy ją
zamkniesz. Jedyna witryna, do której rozszerzenie sięga, to discord.com. Nie ma konta,
serwera, analityki ani telemetrii.

Rozszerzenie prosi o jedno uprawnienie, pamięć, i używa go do zapamiętania numeru karty.

ZANIM ZACZNIESZ

Automatyzowanie konta użytkownika jest niezgodne z regulaminem Discorda i zdarza się, że
konta obrywają za to karę. Clearline hamuje się znacznie bardziej niż alternatywy, co
zmniejsza ryzyko, ale go nie usuwa. Jeśli utrata konta byłaby poważnym problemem,
najpierw wyeksportuj i zastanów się, czy usuwanie jest tego warte.

W rozszerzeniu jest jeden link, do strony Buy Me a Coffee, na dole okna. Jest opcjonalny,
jest linkiem i niczym więcej, i nic nie jest z tej strony pobierane, dopóki go nie
klikniesz.

Clearline jest darmowy i ma otwarty kod na licencji MIT. Bez powiązania, poparcia ani
związku z Discord Inc.
```

---

## Turkish (tr)

**Name**

```
Clearline - Discord için Mesaj Yöneticisi
```

**Summary**

```
Kendi Discord mesajlarını ara, dışa aktar ve toplu sil. Jetonun tarayıcıdan asla çıkmaz.
```

**Description**

```
Clearline, Discord'da yazdığın mesajları bulur, sana gösterir ve saklamana ya da
kaldırmana izin verir.

Discord'da bir seferde birden fazla mesajı silmenin hiçbir yolu yok. Clearline bunları
senin yerine, dikkatle tek tek geçer ve hiçbir şeye dokunmadan önce tam olarak neye
dokunacağını gösterir.

NASIL ÇALIŞIR

Bir sekmede Discord'u aç, giriş yap ve Clearline simgesine tıkla. Beş adımda, her seferde
tek ekran olarak ilerler.

1. Bağlan. Clearline oturumunu, zaten açık olan Discord sekmenden okur.
2. Nerede. Bir sunucu, onun bazı kanalları ya da bir özel mesaj seç.
3. Daralt. Metne ya da bir kalıba, tarih aralığına, mesajın eki, bağlantısı veya bağlantı
   önizlemesi olup olmadığına göre filtrele ve sabitlenmiş mesajlara dokunulup
   dokunulmayacağına karar ver.
4. Gözden geçir. Sayıyı ve mesajların kendisini gör. Saklamak istediklerinin işaretini
   kaldır. HTML, JSON veya CSV olarak bir kopya kaydet.
5. Uygula. Sil, metnin üzerine yaz, ya da üzerine yazıp sonra sil. İlerlemeyi izle,
   duraklat veya durdur.

VARSAYILAN OLARAK TEMKİNLİ

Önce bir sayıyı ve arkasındaki mesajları görmeden silme düğmesine ulaşılamaz. Başlamadan
önce sade bir cümle görürsün: kaç mesaj, hangi yerde, neyle eşleşen, aşağı yukarı ne
kadar süreceği ve geri alınamayacağı. Yüzün üzerindeki işlemlerde sayıyı geri yazman
istenir. Kopya, ilk silmeden önce hazırlanıp tarayıcına teslim edilir; yani başarısız
olacaksa mesajlar hâlâ dururken olur.

Sayıya yalnızca Discord'un gerçekten silmene izin vereceği mesajlar dahildir. Katılma
bildirimleri ve benzeri sistem mesajları sana atfedilir ve sonuçlarda görünür ama kimse
onları silemez; bu yüzden Clearline onları ayrıca adlandırır ve elinden geleninden
fazlasını vaat etmek yerine dokunmadan bırakır.

Sonunda, başarısız olanları atlananlardan ayıran ve başarısızları tekrar denemeyi öneren
bir rapor alırsın.

HESABININ DAYANACAĞI BİR HIZDA

Bu, en çok önem taşıyan ve en kolay yanlış yapılan kısım.

Her istek tek bir kuyruktan, teker teker geçer ve yazma işlemleri arasında düşüremeyeceğin
bir gecikme vardır. Hız sınırı yanıtları okunur ve uygulanır. Üst üste dört tanesi işlemi
durdurur, çünkü bunları üretmeye devam etmek tam olarak bir IP adresinin bir saatliğine
engellenmesine yol açan şeydir.

Aynı anda yalnızca bir Clearline sekmesi çalışır, çünkü ikinci sekme ikinci bir kuyruk
olur ve Discord iki katı hız görür. İkinci sekme bunu söyler ve devralmayı önerir.

JETONUN

Discord'un, bir uygulamaya kendi mesaj geçmişini okuma ya da silme yetkisi vermenin bir
yolu yok; bu yüzden bunun gibi araçlar tarayıcının zaten elinde tuttuğu oturumla çalışır.
Bunu açıkça söylemek, üstünü örtmekten daha önemli.

Clearline oturumunu açık bir Discord sekmesinden, yalnızca Bağlan'a tıkladığında okur. O
sekmenin belleğinde kalır, hiçbir zaman depolamaya yazılmaz ve sekmeyi kapattığında yok
olur. Uzantının ulaşabildiği tek site discord.com. Hesap yok, sunucu yok, analiz yok,
telemetri yok.

Uzantı tek bir izin ister, depolama, ve onu tek bir sekme numarasını hatırlamak için
kullanır.

KULLANMADAN ÖNCE

Bir kullanıcı hesabını otomatikleştirmek Discord'un hizmet şartlarına aykırıdır ve bu
yüzden hesabına yaptırım uygulanan insanlar var. Clearline kendini alternatiflerden çok
daha fazla sınırlar; bu ihtimali düşürür ama ortadan kaldırmaz. Hesabı kaybetmek ciddi
bir sorun olacaksa, önce dışa aktar ve silmenin buna değip değmediğine karar ver.

Uzantıda tek bir bağlantı var, pencerenin altında bir Buy Me a Coffee sayfasına. İsteğe
bağlı, sadece bir bağlantı ve tıklamadığın sürece o siteden hiçbir şey istenmez.

Clearline ücretsiz ve MIT lisansıyla açık kaynaktır. Discord Inc. ile bağlantılı,
tarafından onaylanmış ya da ilişkili değildir.
```

---

## Russian (ru)

**Name**

```
Clearline - менеджер сообщений для Discord
```

**Summary**

```
Поиск, экспорт и массовое удаление своих сообщений в Discord. Токен никогда не покидает браузер.
```

**Description**

```
Clearline находит сообщения, которые вы написали в Discord, показывает их вам и даёт их
сохранить или удалить.

В Discord нет способа удалить больше одного сообщения за раз. Clearline проходит по ним
за вас, аккуратно, и показывает, чего именно собирается коснуться, прежде чем коснуться
хоть чего-то.

КАК ЭТО РАБОТАЕТ

Откройте Discord во вкладке, войдите в аккаунт и нажмите на значок Clearline. Всё идёт в
пять шагов, по одному экрану за раз.

1. Подключение. Clearline читает вашу сессию из вкладки Discord, которая у вас и так
   открыта.
2. Где. Выберите сервер, отдельные его каналы или личную переписку.
3. Фильтр. Отбирайте по тексту или шаблону, по диапазону дат, по наличию вложения,
   ссылки или превью, и решите, трогать ли закреплённые сообщения.
4. Проверка. Посмотрите на количество и на сами сообщения. Снимите галочки с того, что
   хотите оставить. Сохраните копию в HTML, JSON или CSV.
5. Действие. Удалить, заменить текст, либо заменить и затем удалить. Следите за ходом,
   ставьте на паузу или останавливайте.

ОСТОРОЖЕН ПО УМОЛЧАНИЮ

До кнопки удаления нельзя добраться, не увидев сначала количество и сами сообщения. Перед
запуском вы получаете простую фразу: сколько сообщений, в каком месте, подходящих под
что, сколько это примерно займёт и что отменить это нельзя. При количестве больше ста вас
просят ввести число заново. Копия готовится и передаётся браузеру до первого удаления, а
не одновременно с ним, так что если ей суждено не получиться, это случится, пока
сообщения ещё на месте.

В количество попадают только те сообщения, которые Discord действительно позволит
удалить. Уведомления о входе и подобные системные сообщения приписаны вам и возвращаются
в результатах, но удалить их не может никто, поэтому Clearline называет их отдельно и
оставляет в покое, вместо того чтобы обещать больше, чем может выполнить.

В конце вы получаете отчёт, который отделяет неудачи от пропущенного и предлагает
повторить неудачные.

В ТЕМПЕ, КОТОРЫЙ ВЫДЕРЖИТ ВАШ АККАУНТ

Это самая важная часть и та, которую проще всего испортить.

Каждый запрос идёт через одну очередь, по одному, с задержкой между записями, которую
нельзя уменьшить. Ответы об ограничении частоты читаются и соблюдаются. Четыре подряд
останавливают выполнение, потому что продолжать их порождать это ровно то, из-за чего
IP-адрес блокируют на час.

Одновременно работает только одна вкладка Clearline, потому что вторая была бы второй
очередью и Discord увидел бы удвоенный темп. Вторая вкладка сообщает об этом и предлагает
взять управление.

ВАШ ТОКЕН

В Discord нет способа разрешить приложению читать или удалять вашу собственную историю
сообщений, поэтому инструменты вроде этого работают с сессией, которая у браузера и так
есть. Сказать это прямо важнее, чем обойти стороной.

Clearline читает вашу сессию из открытой вкладки Discord и только тогда, когда вы
нажимаете «Подключиться». Она остаётся в памяти этой вкладки, никогда не записывается в
хранилище и исчезает, когда вкладку закрывают. Единственный сайт, до которого расширение
может дотянуться, это discord.com. Ни аккаунта, ни сервера, ни аналитики, ни телеметрии.

Расширение просит одно разрешение, хранилище, и использует его, чтобы запомнить один
номер вкладки.

ПРЕЖДЕ ЧЕМ ПОЛЬЗОВАТЬСЯ

Автоматизация пользовательского аккаунта противоречит условиям использования Discord, и
за это действительно наказывают. Clearline ограничивает себя куда сильнее альтернатив,
что снижает вероятность, но не убирает её. Если потерять аккаунт было бы серьёзной
проблемой, сначала выгрузите всё и решите, стоит ли удаление того.

В расширении есть одна ссылка, на страницу Buy Me a Coffee, внизу окна. Она
необязательна, это ссылка и не более того, и с того сайта ничего не запрашивается, пока
вы по ней не нажмёте.

Clearline бесплатен и имеет открытый код под лицензией MIT. Не связан с Discord Inc., не
одобрен и не аффилирован с ней.
```

---

## Japanese (ja)

**Name**

```
Clearline - Discord メッセージ管理
```

**Summary**

```
自分の Discord メッセージを検索、書き出し、一括削除。トークンがブラウザーの外に出ることはありません。
```

**Description**

```
Clearline は、あなたが Discord に書いたメッセージを見つけ出し、目で確かめたうえで、保存
したり消したりできるようにします。

Discord には、メッセージを一度に 2 件以上まとめて削除する方法がありません。Clearline が
代わりに一件ずつ丁寧に処理し、何かに手を付ける前に、これから何に手を付けるのかを正確に
見せます。

使い方

タブで Discord を開いてログインし、Clearline のアイコンをクリックします。5 つのステップ
を、一度に 1 画面ずつ進みます。

1. 接続。すでに開いている Discord のタブからセッションを読み取ります。
2. 場所。サーバー、その中のいくつかのチャンネル、またはダイレクトメッセージを選びます。
3. 絞り込み。文字列やパターン、期間、添付ファイル・リンク・リンクプレビューの有無で絞り
   込み、ピン留めされたメッセージをそのままにするかを決めます。
4. 確認。件数とメッセージそのものを見て、残したいもののチェックを外します。HTML、JSON、
   CSV のいずれかで控えを保存できます。
5. 実行。削除する、本文を上書きする、または上書きしてから削除する。進み具合を見ながら、
   一時停止も停止もできます。

はじめから慎重に

件数とその中身を見ないかぎり、削除ボタンには到達できません。開始前には、何件を、どの場所
で、どの条件に一致するものを、おおよそどれくらいの時間をかけて処理するのか、そして取り消
せないことが、平易な文で示されます。100 件を超える場合は、その件数を打ち直す必要がありま
す。控えは最初の削除より前に作られてブラウザーへ渡されるので、失敗するならメッセージがま
だ残っているうちに失敗します。

件数には、Discord が実際に削除を許可するメッセージだけが含まれます。参加通知などのシステ
ムメッセージはあなたのものとして扱われ検索結果にも出てきますが、誰にも削除できません。
Clearline はそれらを別枠で示し、できないことを約束する代わりにそのまま残します。

終了後は、失敗したものと手を付けなかったものを分けたレポートが出て、失敗分の再試行を提案
します。

アカウントが生き残る速度で

ここが最も重要で、最も間違えやすい部分です。

すべてのリクエストは 1 つのキューを 1 件ずつ通り、書き込みの間隔には利用者が下げられない
下限があります。レート制限の応答は読み取って必ず守ります。4 回連続した時点で処理を止めま
す。制限を出し続けることこそが、IP アドレスを 1 時間ブロックさせる原因だからです。

同時に動く Clearline のタブは 1 つだけです。2 つ目のタブは 2 つ目のキューになり、Discord
から見た速度が倍になるためです。2 つ目のタブはそのことを伝え、引き継ぐかどうかを尋ねま
す。

トークンについて

Discord には、自分のメッセージ履歴の読み取りや削除をアプリに許可する仕組みがありません。
そのため、この種のツールはブラウザーがすでに持っているセッションを使って動きます。それを
ぼかさずに書いておくことのほうが大切だと考えています。

Clearline は、あなたが「接続」を押したときにだけ、開いている Discord のタブからセッション
を読み取ります。セッションはそのタブのメモリー内にとどまり、ストレージに書き込まれること
はなく、タブを閉じれば消えます。この拡張機能が到達できるサイトは discord.com だけです。
アカウントもサーバーも解析もテレメトリーもありません。

要求する権限は 1 つ、ストレージだけで、用途はタブ番号を 1 つ覚えておくことです。

使う前に

ユーザーアカウントを自動操作することは Discord の利用規約に反しており、実際に措置を受けた
人もいます。Clearline は同種のツールよりはるかに慎重に速度を抑えますが、それは可能性を下
げるだけで、なくすものではありません。アカウントを失うことが深刻な問題になるなら、まず書
き出したうえで、削除する価値があるかを考えてください。

拡張機能内のリンクは 1 つだけで、ウィンドウ下部の Buy Me a Coffee のページです。任意であ
り、リンク以上のものではなく、クリックしないかぎりそのサイトへは何も要求しません。

Clearline は MIT ライセンスの無料のオープンソースです。Discord Inc. とは提携、承認、関連の
いずれもありません。
```

---

## Korean (ko)

**Name**

```
Clearline - Discord 메시지 관리자
```

**Summary**

```
내 Discord 메시지를 검색하고 내보내고 한 번에 삭제하세요. 토큰은 브라우저 밖으로 나가지 않습니다.
```

**Description**

```
Clearline은 당신이 Discord에 쓴 메시지를 찾아서 보여 주고, 저장하거나 지울 수 있게 해
줍니다.

Discord에는 메시지를 한 번에 두 개 이상 지우는 방법이 없습니다. Clearline이 대신 하나씩
조심스럽게 처리하고, 무엇이든 건드리기 전에 정확히 무엇을 건드릴지 먼저 보여 줍니다.

작동 방식

탭에서 Discord를 열고 로그인한 뒤 Clearline 아이콘을 클릭하세요. 다섯 단계로, 한 번에 한
화면씩 진행합니다.

1. 연결. 이미 열려 있는 Discord 탭에서 세션을 읽습니다.
2. 위치. 서버, 그 서버의 일부 채널, 또는 다이렉트 메시지를 고릅니다.
3. 좁히기. 텍스트나 패턴, 날짜 범위, 첨부 파일과 링크와 링크 미리보기 여부로 거르고,
   고정된 메시지를 그대로 둘지 정합니다.
4. 검토. 개수와 메시지 자체를 봅니다. 남기고 싶은 것은 체크를 해제하세요. HTML, JSON,
   CSV 중 하나로 사본을 저장할 수 있습니다.
5. 실행. 삭제하거나, 본문을 덮어쓰거나, 덮어쓴 뒤 삭제합니다. 진행 상황을 보면서 잠시
   멈추거나 중지할 수 있습니다.

기본값이 신중함

개수와 그 뒤에 있는 메시지를 먼저 보지 않고는 삭제 버튼에 닿을 수 없습니다. 시작 전에
몇 개를, 어디에서, 무엇에 해당하는 것을, 대략 얼마나 걸려서 처리하는지, 그리고 되돌릴 수
없다는 사실이 평이한 문장으로 나옵니다. 100개가 넘으면 그 숫자를 다시 입력해야 합니다.
사본은 첫 삭제 전에 만들어져 브라우저로 넘어가므로, 실패할 것이라면 메시지가 아직 남아
있는 동안에 실패합니다.

개수에는 Discord가 실제로 삭제를 허용하는 메시지만 들어갑니다. 입장 알림 같은 시스템
메시지는 당신 것으로 표시되어 검색 결과에 나오지만 누구도 지울 수 없습니다. 그래서
Clearline은 그것들을 따로 이름 붙여 두고, 할 수 없는 일을 약속하는 대신 그대로 둡니다.

끝나면 실패한 것과 건너뛴 것을 나눈 보고서가 나오고, 실패한 것들을 다시 시도할지 물어봅
니다.

계정이 버틸 수 있는 속도로

가장 중요하고, 가장 틀리기 쉬운 부분입니다.

모든 요청은 하나의 대기열을 하나씩 지나가며, 쓰기 사이에는 사용자가 낮출 수 없는 간격이
있습니다. 속도 제한 응답은 읽고 그대로 지킵니다. 연속 네 번이면 작업을 멈춥니다. 계속
제한을 만들어 내는 것이야말로 IP 주소가 한 시간 동안 차단되는 원인이기 때문입니다.

한 번에 하나의 Clearline 탭만 작동합니다. 두 번째 탭은 두 번째 대기열이 되어 Discord 쪽
에서 보이는 속도가 두 배가 되기 때문입니다. 두 번째 탭은 그 사실을 알려 주고 넘겨받을지
물어봅니다.

토큰에 대해

Discord에는 앱이 내 메시지 기록을 읽거나 지우도록 허가하는 방법이 없습니다. 그래서 이런
종류의 도구는 브라우저가 이미 가지고 있는 세션으로 동작합니다. 이 점을 흐리지 않고 분명히
적어 두는 편이 더 중요하다고 봅니다.

Clearline은 당신이 연결을 누를 때만, 열려 있는 Discord 탭에서 세션을 읽습니다. 세션은 그
탭의 메모리에만 있고 저장소에 기록되지 않으며, 탭을 닫으면 사라집니다. 이 확장 프로그램이
닿을 수 있는 사이트는 discord.com 하나뿐입니다. 계정도, 서버도, 분석도, 원격 측정도
없습니다.

확장 프로그램이 요구하는 권한은 저장소 하나이며, 탭 번호 하나를 기억하는 데 씁니다.

쓰기 전에

사용자 계정을 자동화하는 것은 Discord 서비스 약관에 어긋나며, 실제로 제재를 받은 사람들이
있습니다. Clearline은 다른 도구보다 훨씬 더 스스로를 억제하지만, 그것은 가능성을 낮출 뿐
없애지는 못합니다. 계정을 잃는 것이 심각한 문제라면 먼저 내보내 두고, 삭제할 만한 가치가
있는지 판단하세요.

확장 프로그램 안에는 창 아래쪽의 Buy Me a Coffee 페이지로 가는 링크 하나가 있습니다.
선택 사항이고, 링크 그 이상은 아니며, 클릭하지 않는 한 그 사이트에 아무것도 요청하지
않습니다.

Clearline은 MIT 라이선스의 무료 오픈 소스입니다. Discord Inc.와 제휴, 보증, 관련이
없습니다.
```
